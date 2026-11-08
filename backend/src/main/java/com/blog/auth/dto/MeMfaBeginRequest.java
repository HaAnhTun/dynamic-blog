package com.blog.auth.dto;

import jakarta.validation.constraints.Size;

/** Turning two-step verification on: the current password, for an account that has one. {@link #toString()} is redacted. */
public record MeMfaBeginRequest(@Size(max = 512) String currentPassword) {

    @Override
    public String toString() {
        return "MeMfaBeginRequest[redacted]";
    }
}
