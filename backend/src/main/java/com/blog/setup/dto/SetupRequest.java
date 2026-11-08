package com.blog.setup.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * The first-run setup form. The constraints are checked by SetupService only AFTER the setup code (not with
 * {@code @Valid} in the controller): without the code, nobody learns anything about the form or the accounts.
 *
 * {@code siteName} is accepted and not used here; it is bounded only so that a body cannot carry a huge value. The setup code has
 * no bound of its own: an operator may choose a long {@code SETUP_TOKEN}, and the size of the whole body is bounded by
 * {@code RequestSizeLimitFilter} before anything is read.
 *
 * {@link #toString()} is redacted: the code and the password must never reach a log line through this record.
 */
public record SetupRequest(
        String setupCode,

        @NotBlank @Email @Size(max = 120) @Pattern(regexp = "[^\\s\\p{Cntrl}]*", message = "must not contain spaces")
        String email,

        @NotNull @Size(min = 12, max = 128) String password,
        @NotBlank @Size(max = 60) String displayName,
        @Size(max = 120) String siteName) {

    @Override
    public String toString() {
        return "SetupRequest[redacted]";
    }
}
