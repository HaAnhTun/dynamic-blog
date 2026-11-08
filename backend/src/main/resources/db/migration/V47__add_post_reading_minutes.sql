-- The reading time of a post is stored with the post, so that a list can show it without reading the body (issue 013: every public
-- list loaded the full text of each post it showed, and computed the figure from it).
--
-- The application sets the column whenever it sets the body (Post.setContent), with the same function that computed the figure
-- before (ReadingTime). 0 means "not computed yet": this migration cannot compute it in SQL (the function skips block marker lines and
-- diagram sources), so the backend fills every row that still has 0 when it starts, before it serves a request
-- (PostReadingMinutesBackfill). A card shows 0 as 1 minute.
ALTER TABLE posts ADD COLUMN reading_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD CONSTRAINT chk_posts_reading_minutes CHECK (reading_minutes >= 0);
