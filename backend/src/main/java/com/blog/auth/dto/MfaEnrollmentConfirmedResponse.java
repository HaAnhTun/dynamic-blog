package com.blog.auth.dto;

import java.util.List;

/**
 * An enrollment that has just been confirmed: the session of the new authenticator and the ten recovery codes, shown
 * once and never again (the status endpoint answers only a count). {@link #toString()} is redacted.
 *
 * @param recoveryCodes ten codes in their shown form, {@code ABCD-EFGH-...}; each works once
 */
public record MfaEnrollmentConfirmedResponse(
        String accessToken, String refreshToken, long expiresIn, long refreshExpiresIn, List<String> recoveryCodes) {

    @Override
    public String toString() {
        return "MfaEnrollmentConfirmedResponse[redacted]";
    }
}
