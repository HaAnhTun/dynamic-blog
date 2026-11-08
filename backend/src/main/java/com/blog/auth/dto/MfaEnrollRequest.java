package com.blog.auth.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Starts the forced enrollment of a sign-in: the challenge of purpose {@code ENROLL} and, when the enrollment window is
 * closed, the operator's enrollment code (one answer, 403, for missing and wrong). {@link #toString()} is redacted.
 */
public record MfaEnrollRequest(
        @NotBlank @Size(max = 128) String challenge,
        @Size(max = 512) String enrollmentCode) {

    @Override
    public String toString() {
        return "MfaEnrollRequest[redacted]";
    }
}
