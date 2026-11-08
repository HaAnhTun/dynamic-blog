-- A post's cover image. SET NULL: deleting an image must never cascade to or block the deletion of the post that points to it.
--
-- The unique index is the ownership rule: a cover image is only uploaded through its own post, so it belongs to exactly one post.
-- Thanks to that, when the cover is replaced or removed, the service can delete the old image without asking whether any other post still uses it.
-- (Postgres treats NULLs as distinct: all posts without a cover can still coexist.)
ALTER TABLE posts ADD COLUMN cover_media_id UUID REFERENCES media(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_posts_cover_media_id ON posts (cover_media_id);
