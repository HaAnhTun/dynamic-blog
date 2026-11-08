-- V6 (P2-6): post revisions, kept minimal. Each row is the text of a post (title, excerpt, content) at a point in time before
-- an edit, so it can be restored after a slip. It is not a version control system: no diff, no branches, and it does not record the slug, status
-- or classification.
--
-- Only PostRevisionService writes, in the same transaction as the post edit:
--   - a save that changes the title, excerpt or content records the state BEFORE the save, unless the post already has a record in
--     the last 10 minutes (consecutive saves of one writing session merge into one);
--   - a restore records the current state first, without merging, so every restore can be undone;
--   - each post keeps its 20 most recent revisions; older ones are deleted within that same write.
--
-- The text columns have the same types as posts (V5). created_by is the person whose save caused this revision to be recorded; SET NULL: deleting an account
-- must neither cascade to nor block the post's history. Hard-deleting a post cascades to all of its revisions (ON DELETE CASCADE).
CREATE TABLE post_revisions (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    title      VARCHAR(255) NOT NULL,
    excerpt    TEXT,
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL
);

-- Every read is by one post, newest first: the list, "is there a revision within 10 minutes", and the statement that keeps 20. It is also
-- the index for the cascading delete when a post is deleted.
CREATE INDEX idx_post_revisions_post_created ON post_revisions (post_id, created_at DESC);
