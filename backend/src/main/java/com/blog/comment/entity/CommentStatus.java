package com.blog.comment.entity;

/**
 * Comment status ({@code comments.status}, V19).
 *
 * HIDDEN means an admin hid it; DELETED is a soft delete (author or admin), the content is kept for moderation.
 * Readers only see VISIBLE; a root comment that is no longer VISIBLE shows up only as a placeholder when VISIBLE
 * replies remain below it.
 */
public enum CommentStatus {
    VISIBLE,
    HIDDEN,
    DELETED
}
