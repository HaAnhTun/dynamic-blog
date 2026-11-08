package com.blog.auth.service;

import com.blog.auth.dto.ChangePasswordRequest;
import com.blog.auth.dto.MfaEnrollmentConfirmedResponse;
import com.blog.auth.dto.MfaEnrollmentSecretResponse;
import com.blog.auth.dto.MfaRecoveryCodesResponse;
import com.blog.auth.dto.MfaStatusResponse;
import com.blog.auth.dto.TokenResponse;
import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.common.security.AdminAccountProperties;
import com.blog.common.security.PasswordPolicy;
import com.blog.user.entity.User;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserRepository;
import com.blog.user.service.CurrentUserService;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

/**
 * The front door of the signed-in account's security: two-step verification management and the password change. It does
 * everything that must happen BEFORE a database transaction opens, in this order, and then hands the write to
 * {@link MfaService} or {@link PasswordChangeService}:
 * <ol>
 *   <li>(password change only) the {@code ADMIN_PASSWORD} guard: while the variable is set, a password changed here would be
 *       undone at the next start, so the answer is 409 before anything else is looked at;</li>
 *   <li>the recent sign-in ({@link RecentAuthentication}), before any code is looked at or counted;</li>
 *   <li>the per-person rate limit;</li>
 *   <li>the current password where the account has one ({@link PasswordCheck}: Argon2 through the login limiter), and for a
 *       password change the new password's policy and its hash. An account without a password proves itself with the fresh
 *       sign-in alone, so a stolen author cookie cannot enrol an authenticator of the thief's own.</li>
 * </ol>
 * Nothing here logs. The code, the passwords and the hashes stay in locals.
 */
@Service
@RequiredArgsConstructor
public class AccountSecurityService {

    private final UserRepository userRepository;
    private final RecentAuthentication recentAuthentication;
    private final RateLimiter rateLimiter;
    private final PasswordCheck passwordCheck;
    private final PasswordPolicy passwordPolicy;
    private final PasswordEncoder passwordEncoder;
    private final AdminAccountProperties adminProperties;
    private final MfaService mfaService;
    private final PasswordChangeService passwordChangeService;

    // --- Status ---------------------------------------------------------------------------------------------

    public MfaStatusResponse status() {
        User user = caller();
        return mfaService.status(user, passwordManagedByEnvironment(user));
    }

    // --- Two-step verification --------------------------------------------------------------------------------

    public MfaEnrollmentSecretResponse beginEnrollment(String currentPassword) {
        User user = stepUp();
        passwordCheck.requireCurrent(user, currentPassword);
        return mfaService.beginSelfEnrollment(user.getId());
    }

    public MfaEnrollmentConfirmedResponse confirmEnrollment(String code) {
        return mfaService.confirmSelfEnrollment(stepUp().getId(), code);
    }

    public MfaRecoveryCodesResponse regenerateRecoveryCodes(String code, String currentPassword) {
        User user = stepUp();
        passwordCheck.requireCurrent(user, currentPassword);
        return mfaService.regenerateRecoveryCodes(user.getId(), code);
    }

    public MfaEnrollmentSecretResponse beginReplace(String code, String currentPassword) {
        User user = stepUp();
        passwordCheck.requireCurrent(user, currentPassword);
        return mfaService.beginReplace(user.getId(), code);
    }

    public MfaEnrollmentConfirmedResponse confirmReplace(String code) {
        return mfaService.confirmReplace(stepUp().getId(), code);
    }

    public TokenResponse disable(String code) {
        return mfaService.disable(stepUp().getId(), code);
    }

    /** An administrator resets the two-step verification of an author who lost the device. */
    public void resetAuthorEnrollment(UUID targetId, String code) {
        User actor = stepUp();
        mfaService.resetAuthorEnrollment(actor.getId(), targetId, code);
    }

    // --- Password ---------------------------------------------------------------------------------------------

    /**
     * Changes the password of the signed-in account and answers its new session. The old password and the other devices'
     * sessions die: every session is revoked, then the caller is issued a new one.
     *
     * @throws ApiException 409 {@code PASSWORD_MANAGED_BY_ENVIRONMENT}; 401 {@code REAUTHENTICATION_REQUIRED}; 400
     *                      {@code VALIDATION_ERROR} (no password on this account, or the new password breaks the
     *                      policy); 401 {@code INVALID_CREDENTIALS} (wrong current password); 401
     *                      {@code MFA_CODE_INVALID} and the other second-step answers; 429 {@code RATE_LIMITED}
     */
    public TokenResponse changePassword(ChangePasswordRequest request) {
        User user = caller();
        if (passwordManagedByEnvironment(user)) {
            throw new ApiException(
                    ErrorCode.PASSWORD_MANAGED_BY_ENVIRONMENT,
                    HttpStatus.CONFLICT,
                    "The password is set by the ADMIN_PASSWORD setting of the server; remove it to change the password here");
        }
        recentAuthentication.require();
        rateLimiter.check(RateLimiter.PASSWORD_CHANGE, user.getId());
        if (!PasswordCheck.hasPassword(user)) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "This account has no password to change");
        }
        passwordCheck.requireCurrent(user, request.currentPassword());
        // The policy before the code: a refused new password must not burn the one-time code of this 30-second step.
        passwordPolicy.require("newPassword", request.newPassword(), user.getEmail(), request.currentPassword());
        String newHash = passwordEncoder.encode(request.newPassword());
        return passwordChangeService.apply(user.getId(), newHash, request.code());
    }

    // --- Shared ---------------------------------------------------------------------------------------------

    /** The prelude of every mutation of two-step verification: recent sign-in, then the rate limit. */
    private User stepUp() {
        User user = caller();
        recentAuthentication.require();
        rateLimiter.check(RateLimiter.MFA_STEP_UP, user.getId());
        return user;
    }

    private User caller() {
        User user = userRepository
                .findById(AuthenticatedUser.requireUserId())
                .orElseThrow(() -> new ApiException(
                        ErrorCode.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, "Authenticated user no longer exists"));
        if (user.getStatus() == UserStatus.SUSPENDED) {
            throw CurrentUserService.suspended();
        }
        return user;
    }

    /** The account {@code ADMIN_PASSWORD} applies to: the one whose email is {@code ADMIN_EMAIL}. */
    private boolean passwordManagedByEnvironment(User user) {
        String configured = adminProperties.password();
        return configured != null
                && !configured.isBlank()
                && user.getEmail() != null
                && user.getEmail().equalsIgnoreCase(adminProperties.email());
    }
}
