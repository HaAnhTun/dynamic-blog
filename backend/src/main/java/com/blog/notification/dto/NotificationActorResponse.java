package com.blog.notification.dto;

/**
 * The user who caused a notification, enough to display and no more: no id, email, role or status, like the author
 * of a comment.
 *
 * @param githubLogin null for password-only accounts (admin, author not yet linked to GitHub)
 * @param avatarUrl   null for password-only accounts
 */
public record NotificationActorResponse(String displayName, String githubLogin, String avatarUrl) {}
