package com.blog.auth.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.LoginConcurrencyLimiter;
import com.blog.user.entity.User;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

/**
 * Checks the current password of a signed-in person for the changes that ask for it (the password change, and the
 * enrollment, replacement and regeneration of an account that has a password). It goes through the same
 * {@link LoginConcurrencyLimiter} and the same Argon2 check as the sign-in, so it cannot be used for a flood, and a wrong
 * password gets the login's message.
 *
 * An account WITHOUT a password (every AUTHOR, a promoted GitHub account) has nothing to type: the fresh sign-in that
 * {@link RecentAuthentication} insists on is the proof instead.
 *
 * It must be called outside a database transaction: an Argon2 run takes tens of milliseconds and 19 MiB, and no connection
 * should be held across it.
 */
@Component
@RequiredArgsConstructor
public class PasswordCheck {

    private static final String MESSAGE = "Email or password is incorrect";

    private final PasswordEncoder passwordEncoder;
    private final LoginConcurrencyLimiter loginLimiter;

    /** Whether this account has a password to check. */
    public static boolean hasPassword(User user) {
        return user.getPasswordHash() != null;
    }

    /**
     * @param currentPassword what the person typed; ignored for an account without a password
     * @throws ApiException 401 {@code INVALID_CREDENTIALS} when the account has a password and this is not it (a missing
     *                      value included)
     */
    public void requireCurrent(User user, String currentPassword) {
        if (!hasPassword(user)) {
            return;
        }
        String typed = currentPassword == null ? "" : currentPassword;
        String hash = user.getPasswordHash();
        if (!loginLimiter.verify(() -> passwordEncoder.matches(typed, hash))) {
            throw new ApiException(ErrorCode.INVALID_CREDENTIALS, HttpStatus.UNAUTHORIZED, MESSAGE);
        }
    }
}
