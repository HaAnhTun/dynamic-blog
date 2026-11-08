-- The order the site owner arranges for "Featured posts": 1 is the post to read first. A featured post without a rank
-- (just selected) comes after the ranked ones.
ALTER TABLE posts ADD COLUMN featured_rank INT;

-- A rank only has meaning on a featured post: unselecting a post clears its rank in the same statement.
ALTER TABLE posts ADD CONSTRAINT chk_posts_featured_rank
    CHECK (featured_rank IS NULL OR (featured AND featured_rank >= 1));

-- Checked immediately at each statement, for the same reason as uq_posts_series_position: the order is replaced by clearing all
-- ranks first and then assigning 1..n, so two posts never share a rank, not even for a moment.
ALTER TABLE posts ADD CONSTRAINT uq_posts_featured_rank UNIQUE (featured_rank);
