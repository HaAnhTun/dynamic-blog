-- V50: database backstops for invariants that only the application kept.
--
-- Each of these is a rule the service code already follows. The database now refuses the row too, so a hand-written statement, a
-- script (scripts/content-sync/merge-content.sql) or a future bug cannot break it quietly. Existing rows are checked when the
-- constraint is added (VALIDATE): if one is wrong the migration stops and names the constraint. Find the rows with the query
-- in docs/UPGRADING.md ("Database constraints on posts") and fix them, then start again.

-- A PUBLISHED post has a publish date. publish() always set both; a row written before that was an invariant may have no date,
-- so it gets the last time it changed.
UPDATE posts SET published_at = COALESCE(updated_at, created_at) WHERE status = 'PUBLISHED' AND published_at IS NULL;

ALTER TABLE posts
    ADD CONSTRAINT chk_posts_status CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')) NOT VALID,
    ADD CONSTRAINT chk_posts_published_at CHECK (status <> 'PUBLISHED' OR published_at IS NOT NULL) NOT VALID,
    -- What SlugGenerator writes: lower case letters and digits, single hyphens between them. The same pattern as users.public_slug.
    ADD CONSTRAINT chk_posts_slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$') NOT VALID;
ALTER TABLE posts VALIDATE CONSTRAINT chk_posts_status;
ALTER TABLE posts VALIDATE CONSTRAINT chk_posts_published_at;
ALTER TABLE posts VALIDATE CONSTRAINT chk_posts_slug_format;

-- An image stored in the database is at most 4 MiB (media.byte_size has the same limit, V11).
ALTER TABLE media_content
    ADD CONSTRAINT chk_media_content_size CHECK (octet_length(data) <= 4194304) NOT VALID;
ALTER TABLE media_content VALIDATE CONSTRAINT chk_media_content_size;

-- A slug is either the current slug of a post or an old slug of ANOTHER post, never both: otherwise the link of the old slug
-- opens a different post than the one the reader expects. PostService checks it in five places; these two triggers make the
-- database refuse the second row whichever statement writes it. (A post takes back its own old slug by deleting that history
-- row first, so the same-post case never reaches them.)
CREATE FUNCTION post_slug_history_not_a_current_slug() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM posts p WHERE p.slug = NEW.old_slug AND p.id <> NEW.post_id) THEN
        RAISE EXCEPTION 'old slug % is the current slug of another post', NEW.old_slug
            USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_post_slug_history_not_current';
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_post_slug_history_not_current
    BEFORE INSERT OR UPDATE OF old_slug, post_id ON post_slug_history
    FOR EACH ROW EXECUTE FUNCTION post_slug_history_not_a_current_slug();

CREATE FUNCTION post_slug_not_an_old_slug_of_another_post() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM post_slug_history h WHERE h.old_slug = NEW.slug AND h.post_id <> NEW.id) THEN
        RAISE EXCEPTION 'slug % is the old slug of another post', NEW.slug
            USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_posts_slug_not_old_slug';
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

-- On UPDATE this is an AFTER trigger, on purpose. A BEFORE UPDATE row trigger makes PostgreSQL lock the row with FOR UPDATE
-- whenever the statement lists a unique column such as slug in its SET clause (Hibernate lists every column of a post), and
-- FOR UPDATE waits for the FOR KEY SHARE lock that a reader's comment or reply holds on the post: unpublishing a post would then
-- wait for a comment being written, which CommentConcurrencyIT forbids. An AFTER trigger takes no lock, and the WHEN clause
-- skips the update that does not change the slug.
CREATE TRIGGER trg_posts_slug_not_an_old_slug_insert
    BEFORE INSERT ON posts
    FOR EACH ROW EXECUTE FUNCTION post_slug_not_an_old_slug_of_another_post();

CREATE TRIGGER trg_posts_slug_not_an_old_slug_update
    AFTER UPDATE OF slug ON posts
    FOR EACH ROW WHEN (OLD.slug IS DISTINCT FROM NEW.slug)
    EXECUTE FUNCTION post_slug_not_an_old_slug_of_another_post();

-- A reply cannot have replies: a comment whose parent is itself a reply is refused (CommentService allows one level). The foreign key
-- already makes the parent belong to the same post.
CREATE FUNCTION comment_parent_is_a_root() RETURNS trigger AS $$
BEGIN
    IF NEW.parent_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM comments c WHERE c.id = NEW.parent_id AND c.parent_id IS NOT NULL) THEN
        RAISE EXCEPTION 'a reply cannot have replies'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_comments_reply_depth';
    END IF;
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_comments_reply_depth
    BEFORE INSERT OR UPDATE OF parent_id ON comments
    FOR EACH ROW EXECUTE FUNCTION comment_parent_is_a_root();
