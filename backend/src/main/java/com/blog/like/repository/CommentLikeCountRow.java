package com.blog.like.repository;

import java.util.UUID;

/**
 * The like count of one comment, one row of the batch count ({@link CommentLikeRepository#countByCommentIdIn}).
 * A comment nobody liked has no row: callers treat a missing row as 0.
 */
public interface CommentLikeCountRow {

    UUID getCommentId();

    long getLikes();
}
