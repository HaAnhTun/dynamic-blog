package com.blog.user.dto;

import java.time.Instant;

/**
 * The public profile of an account: only what comments and the author line already make public, plus the join date
 * and the number of published posts. It never carries an email, role, status, internal id or GitHub id.
 *
 * @param githubLogin    null for an account not linked to GitHub
 * @param avatarUrl      null for an account not linked to GitHub
 * @param siteOwner      the seeded admin row; the frontend redirects the blog owner to /about
 * @param joinedAt       {@code users.created_at}
 * @param publishedPosts the number of PUBLISHED posts by this person
 */
public record UserProfileResponse(
        String slug,
        String displayName,
        String githubLogin,
        String avatarUrl,
        boolean siteOwner,
        Instant joinedAt,
        long publishedPosts) {}
