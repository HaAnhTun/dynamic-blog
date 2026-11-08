package com.blog.user.service;

import com.blog.auth.repository.RefreshTokenRepository;
import com.blog.auth.service.MfaRejection;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.common.text.LikePattern;
import com.blog.search.sync.SearchOutbox;
import com.blog.user.dto.UserAdminResponse;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserRepository;
import jakarta.persistence.criteria.Predicate;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.domain.Specification;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Minimal admin user management: list accounts, suspend and reactivate readers. Only ADMIN reaches here: the URL rule
 * {@code /api/v1/admin/users/**} in SecurityConfig.
 *
 * Only accounts with the USER role can be suspended, and nobody suspends themselves. Roles change through
 * {@link #setRole}.
 */
@Service
@RequiredArgsConstructor
public class AdminUserService {

    private static final Logger log = LoggerFactory.getLogger(AdminUserService.class);

    static final int MAX_PAGE_SIZE = 100;
    /** The largest page whose start offset (page × size) still fits an int, the type JPA uses for that offset. */
    private static final int MAX_PAGE = Integer.MAX_VALUE / MAX_PAGE_SIZE;

    private final UserRepository userRepository;
    private final RefreshTokenRepository refreshTokenRepository;
    private final RoleChangeService roleChangeService;
    private final RoleChangeStepUp stepUp;
    private final RateLimiter rateLimiter;
    private final SearchOutbox searchOutbox;

    /**
     * A page of users, newest first; on the same creation time the id decides, so the order is deterministic across
     * pages.
     *
     * @param q      searches the GitHub login and display name, case-insensitive; never searches by email
     * @param role   null means every role
     * @param status null means every status
     * @param page   from 0; a negative number is 0
     * @param size   clamped to 1..100
     */
    @Transactional(readOnly = true)
    public Page<UserAdminResponse> list(String q, UserRole role, UserStatus status, int page, int size) {
        PageRequest pageable = PageRequest.of(
                Math.clamp(page, 0, MAX_PAGE),
                Math.clamp(size, 1, MAX_PAGE_SIZE),
                Sort.by(Sort.Order.desc("createdAt"), Sort.Order.desc("id")));
        return userRepository
                .findAll(matching(LikePattern.contains(q), role, status), pageable)
                .map(UserAdminResponse::from);
    }

    /**
     * Suspends ({@code SUSPENDED}) or reactivates ({@code ACTIVE}) a reader, in one transaction. Suspending revokes every
     * live refresh token of that person: their session dies at the next refresh, while the access token they hold is
     * already blocked on every write (CurrentUserService.requireActive). Reactivating restores no session: the person
     * logs in again. Setting the status they already have changes nothing, and is still 200.
     *
     * @param actorId the admin calling, taken from the token
     * @throws ApiException 409 {@code USER_NOT_SUSPENDABLE} when the account is not USER, or is the caller themselves; 404
     *                      {@code USER_NOT_FOUND} when there is no such account
     */
    @Transactional
    public UserAdminResponse setStatus(UUID actorId, UUID userId, UserStatus status) {
        // Nobody may suspend themselves.
        if (userId.equals(actorId)) {
            throw notSuspendable("An administrator cannot change the status of their own account");
        }
        if (userRepository.setStatusIfReader(userId, status.name()) == 0) {
            // No row changed: there is no such account, or it is not a reader. Read again to tell which case it is.
            if (userRepository.findRoleById(userId).isEmpty()) {
                throw new ApiException(ErrorCode.USER_NOT_FOUND, HttpStatus.NOT_FOUND, "User not found: " + userId);
            }
            throw notSuspendable("Only reader accounts (role USER) can be suspended");
        }
        if (status == UserStatus.SUSPENDED) {
            Instant now = Instant.now();
            userRepository.bumpTokensValidAfter(userId, now);
            refreshTokenRepository.revokeAllLiveForUser(userId, now);
        }
        // Suspending hides the author and all their posts from search; reactivating brings them back.
        searchOutbox.authorAndPublishedPosts(userId);
        // Like the role change: who did it to whom, as ids only.
        log.info("user status changed actor={} target={} status={}", actorId, userId, status);
        // The UPDATE statement cleared the persistence context: the User is reloaded with the status just written.
        return userRepository
                .findById(userId)
                .map(UserAdminResponse::from)
                .orElseThrow(() ->
                        new ApiException(ErrorCode.USER_NOT_FOUND, HttpStatus.NOT_FOUND, "User not found: " + userId));
    }

    /**
     * Changes a role. Every rule of the change lives in {@link RoleChangeService}; this adds the per-admin rate limit and the second
     * proof (audit 111): a change to or from ADMIN, or one that makes a reader an author, needs a sign-in from the last minutes and
     * the acting administrator's own code ({@link RoleChangeStepUp}), checked BEFORE anything is written, with the roster locked so
     * that the role it decides on is the role the change then finds. A wrong code is committed (the failed attempt counts), a
     * missing or wrong one changes nothing.
     *
     * @param actorId the admin calling, taken from the token
     * @param code    the admin's own code; only read when the change needs one
     */
    @Transactional(noRollbackFor = MfaRejection.class)
    public UserAdminResponse setRole(UUID actorId, UUID userId, UserRole role, String code) {
        rateLimiter.check(RateLimiter.ROLE_CHANGE, actorId);
        // The roster lock is the one every role change takes (and it is re-entrant in this transaction): after it, the
        // role read
        // here cannot change before the change below. A scalar read, no entity: RoleChangeService must load the target
        // first.
        userRepository.lockAdminRoster();
        // First the authority, as in the change itself: an admin demoted while this request waited for the lock is a
        // 403, not a 401
        // about a session that the demotion has just ended.
        roleChangeService.requireActiveAdmin(actorId);
        userRepository.findRoleById(userId).ifPresent(current -> stepUp.require(actorId, current, role, code));
        roleChangeService.change(actorId, userId, role);
        return userRepository
                .findById(userId)
                .map(UserAdminResponse::from)
                .orElseThrow(() ->
                        new ApiException(ErrorCode.USER_NOT_FOUND, HttpStatus.NOT_FOUND, "User not found: " + userId));
    }

    /** All conditions at once; no condition means every account. */
    private static Specification<User> matching(String pattern, UserRole role, UserStatus status) {
        return (root, query, cb) -> {
            List<Predicate> where = new ArrayList<>(3);
            if (role != null) {
                where.add(cb.equal(root.get("role"), role));
            }
            if (status != null) {
                where.add(cb.equal(root.get("status"), status));
            }
            if (pattern != null) {
                // The pattern is a bind parameter. A null login (a password-only account) gives NULL on that side; the
                // name is always present.
                where.add(cb.or(
                        cb.like(cb.lower(root.<String>get("githubLogin")), pattern, LikePattern.ESCAPE),
                        cb.like(cb.lower(root.<String>get("displayName")), pattern, LikePattern.ESCAPE)));
            }
            return cb.and(where.toArray(Predicate[]::new));
        };
    }

    private static ApiException notSuspendable(String message) {
        return new ApiException(ErrorCode.USER_NOT_SUSPENDABLE, HttpStatus.CONFLICT, message);
    }
}
