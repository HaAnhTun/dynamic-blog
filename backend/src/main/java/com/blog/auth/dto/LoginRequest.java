package com.blog.auth.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * The password sign-in form. {@link #toString()} is redacted: Spring MVC and a debugger print a request body with it, and
 * neither the password nor the address belongs in a log line.
 *
 * <p>Both fields are bounded so that an anonymous body cannot carry a huge value into the password hash: an address is at
 * most 254 characters (RFC 5321) and the password policy stops at 128, so 512 only leaves room for a password set before the
 * policy.
 */
public record LoginRequest(
        @NotBlank @Email @Size(max = 254) String email,
        @NotBlank @Size(max = 512) String password) {

    @Override
    public String toString() {
        return "LoginRequest[redacted]";
    }
}
