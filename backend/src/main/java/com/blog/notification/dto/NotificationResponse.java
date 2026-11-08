package com.blog.notification.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * A notification as the recipient sees it.
 *
 * @param type      {@code POST_LIKED}, {@code POST_COMMENTED}, {@code COMMENT_REPLIED} or {@code COMMENT_LIKED}
 * @param read      the recipient opened it or marked it as read
 * @param commentId the comment to open: the new comment by the actor (post comment, reply), or the recipient's own
 *                  comment (when liked). Always a VISIBLE comment, which is already public; null for
 *                  {@code POST_LIKED}
 * @param excerpt   plain-text excerpt of the comment {@code commentId}, at most 120 code points plus "…" when
 *                  truncated; null for {@code POST_LIKED}
 */
public record NotificationResponse(
        UUID id,
        String type,
        Instant createdAt,
        boolean read,
        NotificationActorResponse actor,
        NotificationPostResponse post,
        UUID commentId,
        String excerpt) {}
