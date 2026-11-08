-- V6 (P1-2): a post's old slugs, so that shared links do not die when the site owner edits a slug. One row per old slug, pointing to the POST and
-- not to the next slug: renaming a → b → c leaves both a and b pointing straight at the post, and the lookup
-- (GET /api/v1/posts/{slug}/redirect) returns its current slug, so it is always exactly one hop, no chain, no loop.
--
-- Only PostService writes, in the same transaction as the slug change, with a SQL statement from PostRepository (there is no entity):
--   - it only writes when the slug of a post that HAS EVER been published (published_at has a value) really changes: a draft that has not launched has no
--     link to preserve;
--   - when a post takes back an old slug of its own, that row is deleted: the slug comes back to life, with no a → c → a loop;
--   - a slug that sits here cannot be taken by any other post, on create or on edit: it gets a suffix as with a slug that is in use.
--     Checked in the service, in the order posts and then this table (see PostService.create), not by a constraint: the slugs are in two tables.
-- The lookup only answers when the post is CURRENTLY published, so the slug of a draft or a taken-down post is never revealed.
--
-- old_slug is the primary key: an old slug belongs to only one post. Same VARCHAR(255) size as posts.slug (V5). Hard-deleting a post cascades to
-- its rows (ON DELETE CASCADE), and that slug can be reused. The post_id index serves that delete.
CREATE TABLE post_slug_history (
    old_slug   VARCHAR(255) PRIMARY KEY,
    post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_post_slug_history_post ON post_slug_history (post_id);
