package com.blog.auth.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * The step-up of a change of two-step verification: a code (an authenticator code, or a recovery code: the person who lost
 * the phone has nothing else) and, for an account that has a password, the current password. {@link #toString()} is
 * redacted.
 */
public record MeMfaStepUpRequest(
        @NotBlank @Size(max = 64) String code,
        @Size(max = 512) String currentPassword) {

    @Override
    public String toString() {
        return "MeMfaStepUpRequest[redacted]";
    }
}
