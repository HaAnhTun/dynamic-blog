package com.blog.author.service;

import com.blog.auth.service.MfaRejection;
import com.blog.author.dto.AuthorApplicationAdminResponse;
import com.blog.author.dto.AuthorApplicationRequest;
import com.blog.author.dto.AuthorApplicationResponse;
import com.blog.author.dto.MyAuthorApplicationResponse;
import com.blog.author.entity.AuthorApplication;
import com.blog.author.entity.AuthorApplicationStatus;
import com.blog.author.repository.AuthorApplicationRepository;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.common.text.UserText;
import com.blog.user.entity.UserRole;
import com.blog.user.repository.UserRepository;
import com.blog.user.service.CurrentUserService;
import com.blog.user.service.RoleChangeService;
import com.blog.user.service.RoleChangeStepUp;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Author applications: a reader submits and views their own application; an ADMIN lists, approves and rejects them.
 *
 * An application never assigns a role by itself: approving changes the role through {@link RoleChangeService}, like a
 * manual change at /admin/users (roster lock, session revocation, log). After a rejection the user can apply again only
 * 30 days after the decision. No notification is sent.
 */
@Service
@RequiredArgsConstructor
public class AuthorApplicationService {

    static final int MAX_MOTIVATION_LENGTH = 500;
    static final Duration COOLDOWN = Duration.ofDays(30);
    static final int MAX_PAGE_SIZE = 100;
    /** The largest page for which the start offset (page x size) still fits an int, the type JPA uses for that offset. */
    private static final int MAX_PAGE = Integer.MAX_VALUE / MAX_PAGE_SIZE;

    private final AuthorApplicationRepository applicationRepository;
    private final UserRepository userRepository;
    private final CurrentUserService currentUserService;
    private final RoleChangeService roleChangeService;
    private final RoleChangeStepUp stepUp;
    private final RateLimiter rateLimiter;

    // --- Applicant ----------------------------------------------------------------------------------------

    /**
     * The caller's latest application, and whether they can submit a new one right now.
     *
     * @throws ApiException 401; 403 {@code USER_SUSPENDED}: like the notification inbox, the application is account-private data
     */
    @Transactional(readOnly = true)
    public MyAuthorApplicationResponse mine() {
        UUID me = currentUserService.requireActive();
        AuthorApplication latest = applicationRepository
                .findFirstByUserIdOrderByCreatedAtDescIdDesc(me)
                .orElse(null);
        Instant reapplyAfter = reapplyAfter(me);
        boolean pending = latest != null && latest.getStatus() == AuthorApplicationStatus.PENDING;
        return new MyAuthorApplicationResponse(
                latest == null ? null : AuthorApplicationResponse.from(latest),
                !pending && reapplyAfter == null && isReader(me),
                reapplyAfter);
    }

    /**
     * /**
     * Submits a PENDING application. The account, the motivation and the rate limit are checked before any SQL on the
     * applications table.
     *
     * @throws ApiException 401; 403 {@code USER_SUSPENDED}; 400 {@code VALIDATION_ERROR}; 429 {@code RATE_LIMITED}; 409
     *                      {@code AUTHOR_APPLICATION_NOT_ALLOWED} (not a USER), {@code AUTHOR_APPLICATION_PENDING}
     *                      (even when the other application is not committed yet), {@code AUTHOR_APPLICATION_COOLDOWN}
     */
    @Transactional
    public AuthorApplicationResponse submit(AuthorApplicationRequest request) {
        UUID me = currentUserService.requireActive();
        String motivation = motivation(request.motivation());
        rateLimiter.check(RateLimiter.AUTHOR_APPLICATION, me);
        if (!isReader(me)) {
            throw conflict(
                    ErrorCode.AUTHOR_APPLICATION_NOT_ALLOWED, "Only reader accounts can apply to become an author");
        }
        UUID id = UUID.randomUUID();
        if (applicationRepository.insertPending(id, me, motivation) == 0) {
            throw conflict(ErrorCode.AUTHOR_APPLICATION_PENDING, "You already have a pending author application");
        }
        // Check the cooldown AFTER the insert: this read takes a fresh snapshot (READ COMMITTED), so a rejection
        // committed
        // before the insert finished is always seen, and the application just inserted rolls back with the error.
        Instant reapplyAfter = reapplyAfter(me);
        if (reapplyAfter != null) {
            throw conflict(
                    ErrorCode.AUTHOR_APPLICATION_COOLDOWN, "A rejected applicant can apply again from " + reapplyAfter);
        }
        return AuthorApplicationResponse.from(find(id));
    }

    // --- Admin --------------------------------------------------------------------------------------------

    /**
     * A page of applications by status, with the applicant: pending ones oldest first (a queue), decided ones most
     * recently decided first.
     *
     * @param page from 0; a negative number is 0
     * @param size clamped to 1..100
     */
    @Transactional(readOnly = true)
    public Page<AuthorApplicationAdminResponse> list(AuthorApplicationStatus status, int page, int size) {
        Sort order = status == AuthorApplicationStatus.PENDING
                ? Sort.by(Sort.Order.asc("createdAt"), Sort.Order.asc("id"))
                : Sort.by(Sort.Order.desc("decidedAt"), Sort.Order.desc("id"));
        return applicationRepository
                .findByStatus(
                        status,
                        PageRequest.of(Math.clamp(page, 0, MAX_PAGE), Math.clamp(size, 1, MAX_PAGE_SIZE), order))
                .map(AuthorApplicationAdminResponse::from);
    }

    /**
     * Approve: the applicant becomes AUTHOR through {@link RoleChangeService#promoteIfReader}, and only then does the
     * application become APPROVED, so the roster lock is always taken before the application row lock. A user who is
     * already AUTHOR or ADMIN keeps their role. Approving an already approved application returns 200 and changes nothing.
     * Making a reader an author wants the acting administrator's own code and a recent sign-in ({@link RoleChangeStepUp}).
     *
     * @param actorId the calling admin, taken from the token
     * @param code    the admin's own code; only read when the approval really promotes a reader
     * @throws ApiException 429 (role-change bucket, per admin); 404 {@code AUTHOR_APPLICATION_NOT_FOUND}; 403
     *                      {@code FORBIDDEN} for the admin's own application; 409 {@code AUTHOR_APPLICATION_DECIDED} when
     *                      the application was, or has just been, rejected (the role change rolls back with it); and
     *                      every error of RoleChangeService
     */
    @Transactional(noRollbackFor = MfaRejection.class)
    public AuthorApplicationAdminResponse approve(UUID actorId, UUID id, String code) {
        rateLimiter.check(RateLimiter.ROLE_CHANGE, actorId);
        // Lock the roster BEFORE reading the application: two duplicate approvals serialize, so the later one sees
        // APPROVED
        // and does not promote again a user who was just demoted by another admin.
        userRepository.lockAdminRoster();
        AuthorApplication application = find(id);
        if (application.getUserId().equals(actorId)) {
            throw new ApiException(
                    ErrorCode.FORBIDDEN, HttpStatus.FORBIDDEN, "You cannot approve your own application");
        }
        if (application.getStatus() == AuthorApplicationStatus.APPROVED) {
            return AuthorApplicationAdminResponse.from(application);
        }
        if (application.getStatus() == AuthorApplicationStatus.REJECTED) {
            throw decided("This application was rejected");
        }
        // Only a reader is promoted (an author or admin keeps their role), and only that change wants the second proof
        // (audit 111): a sign-in from the last minutes and the administrator's own code, checked before anything is
        // written.
        // The authority comes first: an admin demoted while this request waited for the lock is a 403, not a 401.
        roleChangeService.requireActiveAdmin(actorId);
        userRepository
                .findRoleById(application.getUserId())
                .filter(current -> current == UserRole.USER)
                .ifPresent(current -> stepUp.require(actorId, current, UserRole.AUTHOR, code));
        roleChangeService.promoteIfReader(actorId, application.getUserId(), UserRole.AUTHOR);
        if (applicationRepository.decideIfPending(id, AuthorApplicationStatus.APPROVED.name(), actorId) == 0
                && find(id).getStatus() == AuthorApplicationStatus.REJECTED) {
            // Rejected while this approval waited for the roster lock: the error also rolls back the promotion above.
            throw decided("This application was rejected");
        }
        return AuthorApplicationAdminResponse.from(find(id));
    }

    /**
     * Rejects a pending application; changes no role. Rejecting an already rejected application returns 200 and changes
     * nothing.
     *
     * @param actorId the calling admin, taken from the token
     * @throws ApiException 404 {@code AUTHOR_APPLICATION_NOT_FOUND}; 409 {@code AUTHOR_APPLICATION_DECIDED} when the
     *                      application was approved
     */
    @Transactional
    public AuthorApplicationAdminResponse reject(UUID actorId, UUID id) {
        if (applicationRepository.decideIfPending(id, AuthorApplicationStatus.REJECTED.name(), actorId) == 0
                && find(id).getStatus() == AuthorApplicationStatus.APPROVED) {
            throw decided("This application was approved");
        }
        return AuthorApplicationAdminResponse.from(find(id));
    }

    // --- Helpers ------------------------------------------------------------------------------------------

    private AuthorApplication find(UUID id) {
        return applicationRepository
                .findById(id)
                .orElseThrow(() -> new ApiException(
                        ErrorCode.AUTHOR_APPLICATION_NOT_FOUND,
                        HttpStatus.NOT_FOUND,
                        "Author application not found: " + id));
    }

    /** When the 30 days after the most recent rejection end; null when they have already ended, or there was no rejection. */
    private Instant reapplyAfter(UUID userId) {
        return applicationRepository
                .findLastRejectedAt(userId)
                .map(rejectedAt -> rejectedAt.plus(COOLDOWN))
                .filter(after -> after.isAfter(Instant.now()))
                .orElse(null);
    }

    private boolean isReader(UUID userId) {
        return userRepository.findRoleById(userId).orElse(null) == UserRole.USER;
    }

    /**
     * The motivation, sanitized like a comment (UserText.clean: strips control characters, including NUL which Postgres
     * rejects, then trims both ends); empty means none. Length is counted by code point, like the V28 {@code char_length} CHECK.
     */
    private static String motivation(String raw) {
        String cleaned = UserText.clean(raw);
        if (cleaned.codePointCount(0, cleaned.length()) > MAX_MOTIVATION_LENGTH) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.BAD_REQUEST,
                    "Motivation must be at most " + MAX_MOTIVATION_LENGTH + " characters");
        }
        return cleaned.isEmpty() ? null : cleaned;
    }

    private static ApiException conflict(ErrorCode code, String message) {
        return new ApiException(code, HttpStatus.CONFLICT, message);
    }

    private static ApiException decided(String message) {
        return conflict(ErrorCode.AUTHOR_APPLICATION_DECIDED, message);
    }
}
