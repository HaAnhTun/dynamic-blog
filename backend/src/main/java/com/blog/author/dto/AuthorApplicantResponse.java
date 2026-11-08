package com.blog.author.dto;

import com.blog.user.entity.User;
import java.util.UUID;

/**
 * The applicant as the admin sees them, with their current role and status. No email, no GitHub id, like UserAdminResponse.
 *
 * @param githubLogin null for a password-only account
 */
public record AuthorApplicantResponse(
        UUID id, String displayName, String githubLogin, String avatarUrl, String role, String status) {

    public static AuthorApplicantResponse from(User user) {
        return new AuthorApplicantResponse(
                user.getId(),
                user.getDisplayName(),
                user.getGithubLogin(),
                user.getAvatarUrl(),
                user.getRole().name(),
                user.getStatus().name());
    }
}
