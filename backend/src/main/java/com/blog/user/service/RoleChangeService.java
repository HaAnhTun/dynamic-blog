package com.blog.user.service;

import com.blog.auth.repository.RefreshTokenRepository;
import com.blog.auth.service.MfaService;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.security.SeedAdmin;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserRepository;
import java.time.Instant;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * The only path that changes roles (by hand in /admin/users, or by approving an author application). It takes a shared
 * lock before counting admins, so two demotions running at the same time cannot leave the site without an active
 * admin.
 */
@Service
@RequiredArgsConstructor
public class RoleChangeService {

    private static final Logger log = LoggerFactory.getLogger(RoleChangeService.class);

    private final UserRepository userRepository;
    private final RefreshTokenRepository refreshTokenRepository;
    private final MfaService mfaService;

    /**
     * Changes the role of {@code targetId} to {@code role}; if it already has that role, nothing is done. A real change
     * revokes every live refresh token of that person, so the next login carries the new role.
     *
     * Call it before loading any other entity of that user, and do not catch its ApiException: the error marks the
     * caller's transaction rollback-only.
     *
     * @return the role before the change
     * @throws ApiException 403 when the caller is no longer an active admin; 404 {@code USER_NOT_FOUND}; 409
     *                      {@code LAST_ADMIN}, {@code SITE_OWNER_PROTECTED} or {@code ROLE_TARGET_SUSPENDED}
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public UserRole change(UUID actorId, UUID targetId, UserRole role) {
        return apply(actorId, targetId, role, false);
    }

    /**
     * Like {@link #change}, but only promotes a reader (USER): someone who is already AUTHOR or ADMIN keeps their role.
     * Used when approving an author application, so approving an admin's application does not demote them.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public UserRole promoteIfReader(UUID actorId, UUID targetId, UserRole role) {
        return apply(actorId, targetId, role, true);
    }

    /**
     * The acting administrator must still be an active ADMIN, read now: an admin demoted or suspended while their request waited for
     * the roster lock stops here, with 403. The callers that ask for a second proof (RoleChangeStepUp) call it BEFORE they look at
     * the proof, so a demotion that landed in between is the 403 it always was and not a 401 about a session that the demotion ended
     * (audit 111). Call it with the roster lock held.
     *
     * @throws ApiException 403 {@code FORBIDDEN}
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void requireActiveAdmin(UUID actorId) {
        boolean actorIsAdmin = userRepository
                .findAccessById(actorId)
                .map(a -> a.role() == UserRole.ADMIN && a.status() == UserStatus.ACTIVE)
                .orElse(false);
        if (!actorIsAdmin) {
            throw new ApiException(ErrorCode.FORBIDDEN, HttpStatus.FORBIDDEN, "Access denied");
        }
    }

    private UserRole apply(UUID actorId, UUID targetId, UserRole role, boolean onlyFromReader) {
        userRepository.lockAdminRoster();
        // Authority is decided when the request starts: an admin demoted while their request waited for the lock stops
        // here.
        requireActiveAdmin(actorId);
        UserRole current = userRepository.findRoleById(targetId).orElseThrow(() -> notFound(targetId));
        if (current == role || (onlyFromReader && current != UserRole.USER)) {
            return current;
        }
        if (SeedAdmin.ID.equals(targetId) && !SeedAdmin.ID.equals(actorId)) {
            throw new ApiException(
                    ErrorCode.SITE_OWNER_PROTECTED,
                    HttpStatus.CONFLICT,
                    "Only the site owner can change the site owner's role");
        }
        if (current == UserRole.ADMIN && userRepository.countOtherActiveAdmins(targetId) == 0) {
            throw new ApiException(
                    ErrorCode.LAST_ADMIN, HttpStatus.CONFLICT, "The site must keep at least one active administrator");
        }
        if (userRepository.setRoleIfCurrently(targetId, role.name(), current.name()) == 0) {
            // Suspended (may only be demoted to USER), or just merged into the admin and deleted (AdminGithubLink).
            boolean suspended = userRepository
                    .findStatusById(targetId)
                    .map(s -> s == UserStatus.SUSPENDED)
                    .orElse(false);
            if (suspended) {
                throw new ApiException(
                        ErrorCode.ROLE_TARGET_SUSPENDED,
                        HttpStatus.CONFLICT,
                        "Unsuspend the account before giving it a privileged role");
            }
            throw notFound(targetId);
        }
        Instant now = Instant.now();
        userRepository.bumpTokensValidAfter(targetId, now);
        refreshTokenRepository.revokeAllLiveForUser(targetId, now);
        if (role == UserRole.USER || role == UserRole.ADMIN) {
            // A reader has no second step. Delete the enrollment now: an orphan would be enforced again by a later
            // promotion, when the person may have lost the phone. A demotion to AUTHOR keeps it (an enrolled author is
            // enforced like an administrator).
            //
            // A promotion to ADMIN deletes it too (audit 111): an administrator is enrolled by the operator's rules,
            // with the
            // enrollment code, and not with an authenticator an author set up on their own. So a promotion made from a
            // stolen
            // administrator session cannot hand the administrator role to a second step that the operator never saw:
            // the
            // promoted account must enrol again at its next sign-in.
            mfaService.removeEnrollment(targetId, MfaService.RemovedBy.ROLE_CHANGE);
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override
            public void afterCommit() {
                log.info("role changed actor={} target={} from={} to={}", actorId, targetId, current, role);
            }
        });
        return current;
    }

    private static ApiException notFound(UUID id) {
        return new ApiException(ErrorCode.USER_NOT_FOUND, HttpStatus.NOT_FOUND, "User not found: " + id);
    }
}
