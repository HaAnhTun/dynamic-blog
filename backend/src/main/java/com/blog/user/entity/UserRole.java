package com.blog.user.entity;

/**
 * The role, stored by name in {@code users.role} and carried in the {@code role} claim of the access token.
 *
 * Only append at the end (CHECK {@code chk_users_role}, migration V18). A role only changes through RoleChangeService.
 */
public enum UserRole {
    ADMIN,
    AUTHOR,
    // A reader logged in with GitHub: comments and likes posts, cannot enter the admin area.
    USER
}
