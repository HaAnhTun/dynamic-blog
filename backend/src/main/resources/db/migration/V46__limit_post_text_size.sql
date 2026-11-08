-- The text of a post is bounded at the API (PostCreateRequest and PostUpdateRequest: the body at most 500,000 characters, the
-- excerpt at most 1,000, both counted in UTF-16 units), and the database now refuses what the API refuses. Without this a path that
-- does not go through the request validation (an import, a restore, a script with database access) could still store a body of any
-- size, and every public list loads each post it shows.
--
-- char_length counts characters (code points), Java counts UTF-16 units: a text that passes the API's limit never has more
-- characters than the limit here, so the CHECK can only refuse what the API would have refused.
--
-- NOT VALID: the constraint is enforced for every row written from now on, and the migration does not scan the table, so a site
-- that already holds a post above the limit (possible before the API limit existed) still starts. The block below validates the
-- constraints when there is no such post; otherwise it leaves them NOT VALID and says so in the log. A post above the limit stays
-- readable, and a save that shortens it works; a statement that writes its row unchanged in size (a series order, a cover) fails
-- until the text is shortened. docs/UPGRADING.md has the query to find such posts.
--
-- post_revisions gets no CHECK on purpose: a revision is the copy of what the post held before an edit, including text from before
-- the limit, and recording that copy must not stop the author from saving the shortened text.
ALTER TABLE posts
    ADD CONSTRAINT chk_posts_content_size CHECK (char_length(content) <= 500000) NOT VALID;
ALTER TABLE posts
    ADD CONSTRAINT chk_posts_excerpt_size CHECK (excerpt IS NULL OR char_length(excerpt) <= 1000) NOT VALID;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM posts WHERE char_length(content) > 500000 OR char_length(excerpt) > 1000) THEN
        RAISE WARNING 'V46: a post is longer than the limit (content 500000, excerpt 1000 characters); chk_posts_content_size and chk_posts_excerpt_size stay NOT VALID until it is shortened and VALIDATE CONSTRAINT is run';
    ELSE
        ALTER TABLE posts VALIDATE CONSTRAINT chk_posts_content_size;
        ALTER TABLE posts VALIDATE CONSTRAINT chk_posts_excerpt_size;
    END IF;
END
$$;
