-- View counts: one row per post, incremented by a single atomic upsert statement.
--
-- Deliberately not a column on posts: every time an admin saves a post, the entity writes back all of its columns, so a counter
-- living there would be overwritten with the number read a few seconds earlier. No IP stored, no user agent stored, no
-- individual views stored: the table never grows larger than the number of posts, and keeps nothing about the reader.
CREATE TABLE post_views (
    post_id UUID PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
    view_count BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT chk_post_views_count CHECK (view_count >= 0)
);
