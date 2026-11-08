package com.blog.user.dto;

import com.blog.user.entity.User;
import java.time.Instant;
import java.util.UUID;

/**
 * An account as the user-management page sees it. No email, no password hash, no GitHub id: the page only needs to
 * recognize the person and their status.
 *
 * @param githubLogin null for a password-only account
 * @param role        {@code ADMIN}, {@code AUTHOR} or {@code USER}; only USER can be suspended
 * @param status      {@code ACTIVE} or {@code SUSPENDED}
 * @param lastLoginAt the latest GitHub login; null when they never logged in with GitHub
 */
public record UserAdminResponse(
        UUID id,
        String displayName,
        String githubLogin,
        String avatarUrl,
        String role,
        String status,
        Instant createdAt,
        Instant lastLoginAt) {

    public static UserAdminResponse from(User user) {
        return new UserAdminResponse(
                user.getId(),
                user.getDisplayName(),
                user.getGithubLogin(),
                user.getAvatarUrl(),
                user.getRole().name(),
                user.getStatus().name(),
                user.getCreatedAt(),
                user.getLastLoginAt());
    }
}
