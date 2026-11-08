package com.blog.auth.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.util.Map;
import org.springframework.http.HttpStatus;

/**
 * A refusal of the second step whose bookkeeping must be COMMITTED with it: the failed attempt, the lock, the exhausted
 * challenge. {@code ApiException} is a RuntimeException, so by default Spring rolls back and those writes would vanish
 * together with their own 401; the services of the second step list this type, and only this type, in
 * {@code noRollbackFor} (the {@code ReuseDetected} precedent). The messages are stable English sentences that never carry a
 * code, a secret, a challenge or an account.
 */
public class MfaRejection extends ApiException {

    private MfaRejection(ErrorCode code, HttpStatus status, String message, Map<String, Object> details) {
        super(code, status, message, details);
    }

    /** Unknown, expired, consumed, used up, of the wrong purpose or older than the account's cut-off: one answer. */
    public static MfaRejection challengeInvalid() {
        return new MfaRejection(
                ErrorCode.MFA_CHALLENGE_INVALID,
                HttpStatus.UNAUTHORIZED,
                "This sign-in step is not valid any more; sign in again",
                null);
    }

    /** A wrong code, a replayed code or a secret that cannot be read: one answer, the log tells them apart. */
    public static MfaRejection codeInvalid() {
        return new MfaRejection(
                ErrorCode.MFA_CODE_INVALID, HttpStatus.UNAUTHORIZED, "The verification code is not valid", null);
    }

    /** A lock is running (or too many sign-in steps are waiting); {@code retryAfterSeconds} when the wait is known. */
    public static MfaRejection rateLimited(Long retryAfterSeconds) {
        return new MfaRejection(
                ErrorCode.MFA_RATE_LIMITED,
                HttpStatus.TOO_MANY_REQUESTS,
                "Too many attempts; wait a moment and try again",
                retryAfterSeconds == null ? null : Map.of("retryAfterSeconds", retryAfterSeconds));
    }

    /** 100 consecutive wrong codes: waiting does not help. */
    public static MfaRejection frozen() {
        return new MfaRejection(
                ErrorCode.MFA_FROZEN,
                HttpStatus.FORBIDDEN,
                "Two-step verification is locked after too many wrong codes; the server owner has to reset it",
                null);
    }

    /** The operator's enrollment code is missing or wrong: one answer for both. */
    public static MfaRejection enrollmentCodeInvalid() {
        return new MfaRejection(
                ErrorCode.ENROLLMENT_CODE_INVALID, HttpStatus.FORBIDDEN, "The enrollment code is not valid", null);
    }

    /** This session has no verified second factor, but the account needs one. */
    public static MfaRejection required() {
        return new MfaRejection(
                ErrorCode.MFA_REQUIRED,
                HttpStatus.UNAUTHORIZED,
                "Two-step verification is required; sign in again",
                null);
    }
}
