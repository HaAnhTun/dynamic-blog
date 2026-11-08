package com.blog.auth.service;

import com.blog.auth.dto.TokenResponse;
import com.blog.auth.service.MfaVerifier.Target;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.user.entity.User;
import com.blog.user.repository.UserRepository;
import java.time.Clock;
import java.time.Instant;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The write half of a password change: the step-up code (when the account has two-step verification), the new hash, the end
 * of every session and a new session for the caller, in one transaction. The work that must not hold a transaction (the
 * recent sign-in, the rate limit, the current password, the policy and the Argon2 hash of the new password) is done by
 * {@link AccountSecurityService} before it gets here.
 *
 * The revocation is the one primitive that already exists: {@code revokeAllSessions} bumps the account's token cut-off and
 * revokes every refresh token, so every access token dies at its next request, and the caller's new session is issued
 * after the bump with the same start time as the old one (a password change never makes a session look freshly signed in).
 * Challenges of the account that were created before the change are dead too, because they predate the cut-off.
 *
 * Nothing here logs a password, a hash, a code or an email: one line with the user id and how many sessions ended.
 */
@Service
@RequiredArgsConstructor
public class PasswordChangeService {

    private static final Logger log = LoggerFactory.getLogger(PasswordChangeService.class);

    private final UserRepository userRepository;
    private final RefreshTokenService refreshTokenService;
    private final AuthService authService;
    private final MfaPolicy mfaPolicy;
    private final MfaVerifier verifier;
    private final Clock clock;

    /**
     * @param newHash the Argon2id hash of the new password, already checked against the policy
     * @param code    an authenticator code or a recovery code; required when the account has two-step verification
     * @return the caller's new session
     * @throws MfaRejection {@code MFA_CODE_INVALID} for a missing or wrong code (the same answer for both),
     *                      {@code MFA_RATE_LIMITED} and {@code MFA_FROZEN} under the per-account brake
     */
    @Transactional(noRollbackFor = MfaRejection.class)
    public TokenResponse apply(UUID userId, String newHash, String code) {
        User user = userRepository
                .findById(userId)
                .orElseThrow(() -> new ApiException(
                        ErrorCode.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, "Authenticated user no longer exists"));
        SessionProof carried = authService.callerProof();

        boolean verifiedNow = false;
        if (mfaPolicy.enrolled(userId)) {
            if (code == null || code.isBlank()) {
                throw MfaRejection.codeInvalid();
            }
            verifier.stepUp(userId, code, Target.LOGIN, "password_change");
            verifiedNow = true;
        }

        user.setPasswordHash(newHash);
        userRepository.save(user);
        Instant now = clock.instant();
        int revoked = refreshTokenService.revokeAllSessions(userId, now);
        TokenResponse tokens = authService.issueSession(user, verifiedNow ? carried.withVerificationAt(now) : carried);
        log.info("password changed userId={} sessionsRevoked={}", userId, revoked);
        return tokens;
    }
}
