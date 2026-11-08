-- V9C, step 2 of 2 (tighten): constraints and indexes for the columns V34 added.
--
-- The enabled set is part of the schema: a language outside it cannot be stored. Enabling another locale later needs a
-- migration that replaces these CHECK constraints (documented in the contributor guide).
ALTER TABLE posts ADD CONSTRAINT chk_posts_language CHECK (language IN ('vi', 'en'));

-- One post per language in a group. NULL group ids are distinct in a unique constraint, so unlinked posts never collide.
ALTER TABLE posts ADD CONSTRAINT uq_posts_translation_group_language UNIQUE (translation_group_id, language);

-- A language filter always comes with the status and the order of the public lists.
CREATE INDEX idx_posts_language_status_published_at ON posts (language, status, published_at DESC);

ALTER TABLE categories ADD CONSTRAINT chk_categories_translations CHECK (
    jsonb_typeof(translations) = 'object' AND (translations - ARRAY['vi', 'en']) = '{}'::jsonb);
ALTER TABLE tags ADD CONSTRAINT chk_tags_translations CHECK (
    jsonb_typeof(translations) = 'object' AND (translations - ARRAY['vi', 'en']) = '{}'::jsonb);
ALTER TABLE series ADD CONSTRAINT chk_series_translations CHECK (
    jsonb_typeof(translations) = 'object' AND (translations - ARRAY['vi', 'en']) = '{}'::jsonb);

ALTER TABLE newsletter_subscribers ADD CONSTRAINT chk_newsletter_subscribers_locale CHECK (locale IN ('vi', 'en'));
