package com.blog.user.service;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserRepository;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * Who is calling, and whether that account may still write.
 *
 * Every reader write (comment, reply, edit, delete, like) calls {@link #requireActive()} BEFORE anything else. The
 * status is read from the DB each time, not taken from the access token: the token of a just-suspended person stays alive
 * for up to 15 minutes, yet the suspension must take effect from the very next write. The role is still taken from the
 * token, like every URL rule.
 *
 * The user is never taken from the request body: the id is always the {@code sub} of the token authenticated by the
 * filter.
 */
@Service
@RequiredArgsConstructor
public class CurrentUserService {

    private final UserRepository userRepository;

    /**
     * The caller's id, when the account is still in the DB and ACTIVE.
     *
     * @throws ApiException 401 {@code UNAUTHENTICATED} when nobody is logged in, or the account is no longer in the DB
     *                      (the access token of a merged or deleted row may still be valid); 403 {@code USER_SUSPENDED}
     *                      when the account is suspended
     */
    public UUID requireActive() {
        UUID userId = AuthenticatedUser.requireUserId();
        UserStatus status = userRepository
                .findStatusById(userId)
                .orElseThrow(() -> new ApiException(
                        ErrorCode.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, "Authenticated user no longer exists"));
        if (status == UserStatus.SUSPENDED) {
            throw suspended();
        }
        return userId;
    }

    /**
     * 403 {@code USER_SUSPENDED}: one message for every path that refuses a suspended person (writes,
     * {@code /auth/me}, refresh, password login). Next only reads the error code; the message mentions no account.
     */
    public static ApiException suspended() {
        return new ApiException(ErrorCode.USER_SUSPENDED, HttpStatus.FORBIDDEN, "This account is suspended");
    }
}
