package com.blog.auth.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** A code of the authenticator (or of its replacement being confirmed). {@link #toString()} is redacted. */
public record MeMfaCodeRequest(@NotBlank @Size(max = 64) String code) {

    @Override
    public String toString() {
        return "MeMfaCodeRequest[redacted]";
    }
}
