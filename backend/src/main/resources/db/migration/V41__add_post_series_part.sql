-- The number an author declared for a post inside its series ("part 3"), as opposed to series_position, which only
-- orders the members of a series and stays the order key everywhere. NULL when nobody declared a number: every post that
-- was in a series before this migration, and every post an admin put there by hand.
ALTER TABLE posts ADD COLUMN series_part INT;

-- A part exists only together with a series and is a whole number from 1. The pair rule of chk_posts_series_membership
-- (V14) is untouched: this check adds the third column to it.
ALTER TABLE posts ADD CONSTRAINT chk_posts_series_part CHECK (
    series_part IS NULL OR (series_id IS NOT NULL AND series_part >= 1)
);

-- One post per declared number, per series and per language: the part shown to a reader is counted per language, so an
-- English part 3 and a Vietnamese part 3 are different parts and may coexist. Posts without a declared part do not take
-- part in this rule. Checked at each statement, like uq_posts_series_position.
CREATE UNIQUE INDEX uq_posts_series_language_part
    ON posts (series_id, language, series_part)
    WHERE series_part IS NOT NULL;
