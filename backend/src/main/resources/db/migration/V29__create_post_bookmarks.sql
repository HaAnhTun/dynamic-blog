-- V7b: saved posts (bookmarks), same model as post_likes (V20). When a post is taken down the row stays and is only filtered at read time, so
-- republishing makes it reappear; deleting a post or a person takes the row with it (D10). The primary key serves every read by person, and the
-- post_id index serves the cascade when a post is deleted.
CREATE TABLE post_bookmarks (
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, post_id)
);
CREATE INDEX idx_post_bookmarks_post_id ON post_bookmarks (post_id);
