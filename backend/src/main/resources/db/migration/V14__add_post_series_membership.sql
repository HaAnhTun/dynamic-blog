-- A post belongs to at most one series, at one position (1, 2, 3...) in the reading order.
--
-- There is deliberately no ON DELETE (NO ACTION). ON DELETE SET NULL sounds reasonable, but Postgres only nulls the
-- foreign key column, leaving series_position behind, and the CHECK below would block that very DELETE. The service removes the posts from the
-- series first and only then deletes the series; if one day it forgets, the foreign key turns that bug into a 409 instead of leaving
-- half-finished data behind.
ALTER TABLE posts ADD COLUMN series_id UUID REFERENCES series(id);
ALTER TABLE posts ADD COLUMN series_position INT;

-- The position exists if and only if there is a series. The position may have gaps (a post in the middle was removed, or is not yet published): "Part n/m"
-- in the UI is recounted from the published parts at read time and never read straight from this column.
--
-- "series_position IS NOT NULL" in the second branch is not redundant: a CHECK only rejects when the expression evaluates to FALSE, and
-- NULL passes. Without it, a row with a series but a NULL position makes "series_position >= 1" evaluate to NULL, the whole
-- expression evaluates to NULL, and that half-finished row slips through (PostReadModelIT caught exactly this case).
ALTER TABLE posts ADD CONSTRAINT chk_posts_series_membership CHECK (
    (series_id IS NULL AND series_position IS NULL)
    OR (series_id IS NOT NULL AND series_position IS NOT NULL AND series_position >= 1)
);

-- Checked immediately at each statement, not DEFERRABLE: the order is only ever rewritten by "remove the whole series and then assign
-- 1..n" inside one transaction, so a violation is a code bug and must blow up at the statement (409), not at
-- commit. This constraint's index is also the index for every "the posts of series X" query.
ALTER TABLE posts ADD CONSTRAINT uq_posts_series_position UNIQUE (series_id, series_position);
