package com.blog.auth.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * The first code of a new authenticator, with the challenge it belongs to (the forced enrollment of a sign-in).
 * {@link #toString()} is redacted.
 */
public record MfaCodeRequest(
        @NotBlank @Size(max = 128) String challenge,
        @NotBlank @Size(max = 64) String code) {

    @Override
    public String toString() {
        return "MfaCodeRequest[redacted]";
    }
}
