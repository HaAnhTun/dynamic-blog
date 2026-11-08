-- `featured` is author-controlled state the admin UI toggles and the public homepage
-- queries, so it belongs in the database rather than in a frontend data file.
ALTER TABLE posts ADD COLUMN featured BOOLEAN NOT NULL DEFAULT false;

-- Partial, because the only query is "the featured posts a reader can see". Indexing
-- every row would index tens of thousands of `false` values to serve a handful of `true`
-- ones, and a partial index on the exact predicate is both smaller and the one the
-- planner can use for this query without a filter step.
CREATE INDEX idx_posts_featured_published
    ON posts (published_at DESC)
    WHERE featured AND status = 'PUBLISHED';
