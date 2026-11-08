package com.blog.auth.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * {@code GET /api/v1/auth/me}. The first four fields predate the others and keep their order; the last four were
 * added later, appended at the end.
 *
 * {@code email} is null for GitHub readers; {@code githubLogin} and {@code avatarUrl} are null for password-only
 * accounts. It carries no github_id, password hash or token: the Next {@code /api/session} route also strips id, email
 * and status before handing the result to the browser.
 */
public record CurrentUserResponse(
        UUID id,
        String email,
        String displayName,
        String role,
        String githubLogin,
        String avatarUrl,
        String status,
        Instant createdAt) {}
