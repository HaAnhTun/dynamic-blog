package com.blog.auth.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Changing the password of the signed-in account. The rules of the new password are {@code PasswordPolicy}'s (the bounds
 * here only keep a body from carrying a huge value). {@code code} is required when the account has two-step verification.
 * {@link #toString()} is redacted: two passwords and a code must never reach a log through this record.
 */
public record ChangePasswordRequest(
        @NotBlank @Size(max = 512) String currentPassword,
        @NotBlank @Size(max = 512) String newPassword,
        @Size(max = 64) String code) {

    @Override
    public String toString() {
        return "ChangePasswordRequest[redacted]";
    }
}
