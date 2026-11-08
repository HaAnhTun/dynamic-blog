package com.blog.auth.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * The second step of a sign-in. {@code code} is an authenticator code or a recovery code; the server decides by shape. Both
 * fields are bounded so a body cannot be used to push large values around. {@link #toString()} is redacted: the code and the
 * challenge must never reach a log through this record.
 */
public record MfaVerifyRequest(
        @NotBlank @Size(max = 128) String challenge,
        @NotBlank @Size(max = 64) String code) {

    @Override
    public String toString() {
        return "MfaVerifyRequest[redacted]";
    }
}
