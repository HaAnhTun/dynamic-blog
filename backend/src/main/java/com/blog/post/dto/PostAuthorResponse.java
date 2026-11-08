package com.blog.post.dto;

/**
 * The author of a post, enough for the public byline and no more: no id, email or role.
 *
 * @param githubLogin null for an account not linked to GitHub (the seeded admin, an author with only a password)
 * @param avatarUrl   null for an account not linked to GitHub
 * @param siteOwner   the author is the site owner, i.e. the seeded admin row; another ADMIN is also false
 * @param profileSlug public handle, the profile path {@code /api/v1/users/{slug}}; null while that person is suspended
 */
public record PostAuthorResponse(
        String displayName, String githubLogin, String avatarUrl, boolean siteOwner, String profileSlug) {}
