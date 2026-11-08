package com.blog.user.repository;

import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import java.time.Instant;

/**
 * The role, status and token cut-off of an account, read on every request that carries an access token
 * (CurrentAccessJwtConverter).
 */
public record UserAccess(UserRole role, UserStatus status, Instant tokensValidAfter) {

    public UserAccess(UserRole role, UserStatus status) {
        this(role, status, null);
    }
}
