package com.blog.comment.dto;

/**
 * The author of a comment, enough to display and no more: no id, email or role. {@code siteOwner} cannot be
 * faked by a name: a reader's display name follows GitHub, so anyone can pick a name equal to the site owner's.
 *
 * @param githubLogin null for password-only accounts (admin, author not yet linked to GitHub)
 * @param avatarUrl   null for password-only accounts
 * @param siteOwner   the author is the site owner: the seeded admin account ({@code SeedAdmin.ID}), not every ADMIN
 * @param profileSlug public handle, profile route {@code /api/v1/users/{slug}}; null when the author is suspended
 */
public record CommentAuthorResponse(
        String displayName, String githubLogin, String avatarUrl, boolean siteOwner, String profileSlug) {}
