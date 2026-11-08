package com.blog.notification.repository;

import java.time.Instant;
import java.util.UUID;

/**
 * A notification as the recipient's list needs it, read with one SQL statement joining users, posts and comments
 * (NotificationRepository). A projection interface for plain SQL, so Spring Data reads by column name; aliases are
 * quoted to keep the same letter case as the getter names, like CommentStateRow.
 *
 * No id of the actor or of the post: the API response never carries them.
 */
public interface NotificationRow {

    UUID getId();

    /** The name of a {@code NotificationType}, exactly as in the DB. */
    String getType();

    /** Exact to the microsecond as stored in the DB: the keyset cursor compares this value exactly. */
    Instant getCreatedAt();

    boolean getRead();

    String getActorDisplayName();

    /** Null for password-only accounts. */
    String getActorGithubLogin();

    /** Null for password-only accounts. */
    String getActorAvatarUrl();

    String getPostSlug();

    String getPostTitle();

    /** Null for POST_LIKED. */
    UUID getCommentId();

    /** The content of the comment {@link #getCommentId()} (always VISIBLE here); null for POST_LIKED. */
    String getCommentContent();
}
