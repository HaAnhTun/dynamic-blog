-- V6: comment likes, same model as post_likes (V20): one row per (comment, person), no count column.
--
-- Liking twice is still one row: the primary key enforces it in the DB, and the like statement is INSERT ... ON CONFLICT DO NOTHING. The primary key
-- (comment_id, user_id) serves both the batch count for a page of comments and the "have I already liked it" lookup. There is no
-- separate index on user_id, for the same reason as V20: the only place that reads by person is the admin account merge (ADMIN_GITHUB_ID).
CREATE TABLE comment_likes (
    comment_id UUID NOT NULL REFERENCES comments(id) ON DELETE CASCADE,  -- deleting a post cascades to its comments, which cascades here
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (comment_id, user_id)
);
