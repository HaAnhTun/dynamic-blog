package com.blog.comment.repository;

import java.util.UUID;

/**
 * What the service needs to decide a write on an existing comment (check order 404, then 403): whether the comment
 * is still visible, whether its post is still published, who wrote it, whether it is a root or a reply. A
 * projection interface for a plain SQL statement, so Spring Data reads by column name; aliases are quoted to keep
 * the same letter case as the getter names.
 *
 * The statuses are strings exactly as in the DB, not enums: the service compares against
 * {@code CommentStatus.VISIBLE.name()} and {@code PostStatus.PUBLISHED.name()}, the enum names the entities store
 * with {@code EnumType.STRING}.
 */
public interface CommentStateRow {

    UUID getId();

    UUID getPostId();

    UUID getUserId();

    /** Null when it is itself a root comment. */
    UUID getParentId();

    String getContent();

    String getStatus();

    String getPostStatus();
}
