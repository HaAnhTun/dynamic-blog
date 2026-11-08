-- Likes: one row per (post, person). No count column on posts (an admin saving a post overwrites every column, see V16).
--
-- Liking twice is still one row: the primary key enforces it in the DB, and the like statement is INSERT ... ON CONFLICT DO NOTHING. There is no
-- separate index on user_id: the only place that reads by person is the rare admin account merge (ADMIN_GITHUB_ID).
CREATE TABLE post_likes (
    post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, user_id)
);
