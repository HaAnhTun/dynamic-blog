-- V6 (P2-4): images in the post body. An image is uploaded through its own post (POST /api/v1/admin/posts/{id}/images) and belongs to
-- exactly that post, like the cover image (V12) and the gallery image (V17) belong to their owners. Unlike those two, the owner is on the image side: a post
-- has many images in its body, and the post's Markdown only points at them by URL (/media/<id>.<ext>), not by a foreign key.
--
-- post_id only has a value for images in a post body; cover images and gallery images keep NULL (their owner is posts.cover_media_id
-- and gallery_photos.media_id). Thanks to that, "the body images of post X" is exactly one condition, post_id = X, and the delete path for
-- body images can never touch a cover image or a gallery image.
--
-- ON DELETE CASCADE: deleting a post makes the DB delete its media rows, and the bytes follow through the ON DELETE CASCADE foreign key of
-- media_content (V11). The two steps chain within the same DELETE of the post: there is never an orphaned image that a public URL still
-- serves. (A deleted media row is not the cover image of any post, so the ON DELETE SET NULL of posts.cover_media_id has nothing
-- to do.) The new column allows NULL, with no default: adding a column does not rewrite the table, and every existing image keeps its old meaning.
ALTER TABLE media ADD COLUMN post_id UUID REFERENCES posts(id) ON DELETE CASCADE;

-- Two jobs need it: the list of a post's images (WHERE post_id = ?), and the cascading delete when a post is deleted, which runs that very
-- statement on media. Without an index, every post deletion is a scan of the whole media table. Partial (WHERE post_id IS NOT
-- NULL): cover images and gallery images are never looked up by this column, so they do not need to be in the index.
CREATE INDEX idx_media_post_id ON media (post_id) WHERE post_id IS NOT NULL;
