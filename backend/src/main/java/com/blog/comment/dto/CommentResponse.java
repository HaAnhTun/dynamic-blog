package com.blog.comment.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * A comment as the reader sees it.
 *
 * A comment that is no longer VISIBLE appears only as a placeholder for a root comment that still has visible
 * replies: then only the id, status and timestamp remain; content, author, "edited" and "mine" are all empty, so
 * the placeholder reveals nothing about the hidden or deleted comment.
 *
 * The last three fields were added later, at the end, so the existing field order stays unchanged.
 *
 * @param status    {@code VISIBLE}, {@code HIDDEN} or {@code DELETED}
 * @param content   null when not VISIBLE
 * @param author    null when not VISIBLE
 * @param edited    has been edited at least once ("edited"); false when not VISIBLE
 * @param mine      the caller is the author; false for anonymous callers and when not VISIBLE
 * @param editedAt  most recent edit ("edited at"); present exactly when {@code edited} is true, null when never
 *                  edited or not VISIBLE
 * @param likeCount number of likes; 0 when not VISIBLE
 * @param likedByMe the caller liked it; false for anonymous callers and when not VISIBLE
 */
public record CommentResponse(
        UUID id,
        String status,
        String content,
        CommentAuthorResponse author,
        Instant createdAt,
        boolean edited,
        boolean mine,
        Instant editedAt,
        long likeCount,
        boolean likedByMe) {}
