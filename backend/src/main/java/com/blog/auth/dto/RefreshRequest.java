package com.blog.auth.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * The refresh token of a session, to rotate it or to sign out. {@link #toString()} is redacted: the token is a credential. The
 * token is 43 characters of base64url; the bound only keeps a body from carrying a huge value.
 */
public record RefreshRequest(@NotBlank @Size(max = 512) String refreshToken) {

    @Override
    public String toString() {
        return "RefreshRequest[redacted]";
    }
}
