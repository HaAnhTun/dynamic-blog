package com.blog.user.entity;

/**
 * Account status ({@code users.status}, migration V18). Only accounts with the USER role can be suspended.
 *
 * A suspended person cannot log in (password or GitHub), cannot exchange a refresh token, {@code /auth/me} returns 403,
 * and every write (comment, edit, delete, like) is rejected with 403 {@code USER_SUSPENDED}: a write checks the status
 * in the DB (CurrentUserService.requireActive) and does not trust a still-valid access token.
 */
public enum UserStatus {
    ACTIVE,
    SUSPENDED
}
