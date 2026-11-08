package com.blog.newsletter.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * A newsletter that waits for an administrator ({@code GET /api/v1/admin/newsletter/held}): the post of an AUTHOR, published
 * for the first time. {@code title} and {@code excerpt} are exactly what a subscriber would read if it is released now (cleaned
 * and cut the way the mail is). Never an address.
 *
 * @param authorName the display name of the post's author, null when the account no longer has one
 * @param published  whether the post is published now: a held issue of a post taken down waits for it to be published again
 * @param recipients the confirmed subscribers of the post language, who would each get one mail
 * @param version    stands for the text shown here (address, subject, excerpt, language): the administrator sends it back with the
 *                   release, and the release is refused when the post changed since, so only what was read can be mailed
 */
public record NewsletterHeldIssueResponse(
        UUID postId,
        String slug,
        String title,
        String excerpt,
        String language,
        String authorName,
        Instant heldAt,
        boolean published,
        long recipients,
        String version) {}
