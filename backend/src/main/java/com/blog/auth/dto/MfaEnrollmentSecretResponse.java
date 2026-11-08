package com.blog.auth.dto;

/**
 * The new authenticator secret, shown once to the person who is setting it up (the only response that carries it): the
 * base32 text to type, and the {@code otpauth://} link for a phone to open. There is no QR image. {@link #toString()} is
 * redacted: this record must never reach a log.
 *
 * @param secretBase32 the 160-bit secret as 32 upper-case base32 characters (the page shows it in groups of four)
 * @param otpauthUri   {@code otpauth://totp/<issuer>:<account>?secret=...&issuer=...&algorithm=SHA1&digits=6&period=30}
 * @param issuer       the name the authenticator app shows ({@code app.mfa.issuer})
 * @param account      the label of the account in the app: the email, or the public slug of a GitHub account
 */
public record MfaEnrollmentSecretResponse(String secretBase32, String otpauthUri, String issuer, String account) {

    @Override
    public String toString() {
        return "MfaEnrollmentSecretResponse[redacted]";
    }
}
