-- V9C, step 1 of 2 (expand and backfill): every post, newsletter subscriber and taxonomy row learns about languages.
--
-- Existing rows take the default locale of this deployment (Flyway placeholder defaultLocale, set from DEFAULT_LOCALE in
-- application.yml; "vi" for the data of this repository). The default stays on the column so a raw insert or an old code path
-- still produces a valid row; the application always sets the language explicitly. Adding a NOT NULL column with a constant
-- default does not rewrite the table (PostgreSQL 11 and later).
--
-- posts.slug stays globally unique (V5) and post_slug_history (V24) is untouched: a translation has its own slug.
-- translation_group_id links the translations of one article; NULL means "not linked". It is an opaque id, not a foreign key:
-- there is no group table, a group exists as long as two posts carry the same id (V35 makes (group, language) unique).
ALTER TABLE posts ADD COLUMN language VARCHAR(8) NOT NULL DEFAULT '${defaultLocale}';
ALTER TABLE posts ADD COLUMN translation_group_id UUID;

-- Localized names: {"en": {"name": "...", "description": "..."}}, keyed by locale. The base columns (name, title, description)
-- stay the text of the default locale and the fallback when a translation is missing.
ALTER TABLE categories ADD COLUMN translations JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tags ADD COLUMN translations JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE series ADD COLUMN translations JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The language a subscriber reads the blog in: the newsletter sends a post only to subscribers of the post's language.
ALTER TABLE newsletter_subscribers ADD COLUMN locale VARCHAR(8) NOT NULL DEFAULT '${defaultLocale}';
