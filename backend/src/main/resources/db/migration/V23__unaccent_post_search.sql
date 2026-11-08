-- V6 (P1-1): accent-insensitive search. A reader typing the unaccented "hoc" or "duong" must find posts containing the accented
-- Vietnamese words: the most common quick way Vietnamese people type, while the 'simple' configuration of V10 only lowercases and does not strip accents.
--
-- Approach: a dedicated text search configuration, vi_unaccent, copied from 'simple', then every token type that may contain non-ASCII
-- letters is passed through the unaccent dictionary first (strips accents, the Vietnamese D-with-stroke letter, upper and lower case, becomes D/d, including the combining marks of NFD text), then through 'simple' (lowercases,
-- keeps every word: there is no Vietnamese stemmer, and no stop words). The token types that only hold ASCII letters (asciiword,
-- asciihword, hword_asciipart) have nothing to strip, so they keep the mapping of 'simple'. The vector column and every search statement
-- (PostRepository.search) use this same configuration, so both sides strip accents identically.
--
-- Why a configuration and not a call to unaccent() in an expression (the reason V10 did not do it): unaccent() is STABLE and
-- cannot go into a generated column without wrapping it in a function declared IMMUTABLE by hand. to_tsvector(regconfig, text) is
-- already IMMUTABLE, for any configuration. And the configuration is stored in the column's expression by OID, not by name: pg_dump writes it
-- with its schema (public.vi_unaccent), so pg_restore with an empty search_path can still rebuild the column, which a wrapper function calling
-- unaccent() without a schema would break.
--
-- The price of that IMMUTABLE: the stored vector depends on the unaccent.rules file of the Postgres version that computed it. After a major
-- version upgrade with pg_upgrade (the rules file may change), recompute the column: UPDATE posts SET title = title; (an UPDATE that touches
-- title makes Postgres recompute the generated column). Dump and restore does not need it: generated columns are recomputed on load.
--
-- unaccent is a "trusted" extension since PG 13: the database owner can create it, no superuser needed. Managed Postgres providers
-- (Neon, Supabase, RDS, Cloud SQL) all have it on their allow list, but where one does not, this migration stops
-- at the first line, before changing anything. Testcontainers and the compose postgres:18 image both ship it.
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TEXT SEARCH CONFIGURATION vi_unaccent (COPY = pg_catalog.simple);
ALTER TEXT SEARCH CONFIGURATION vi_unaccent
    ALTER MAPPING FOR word, hword, hword_part, numword, numhword, hword_numpart
    WITH unaccent, simple;

-- Drop and re-add the column, not ALTER COLUMN ... SET EXPRESSION: that command only exists since PG 17, and it also rewrites the whole table
-- the same way. Dropping the column takes its GIN index with it; recreate it with the same name and type as V10. Same text expression as V10,
-- no weights: the ranking (ts_rank) keeps its meaning. No other index is added: with a few dozen posts, the planner is right
-- not to use this index (a seq scan, or the (status, published_at) index of V5 followed by a filter, is cheaper); it waits for the blog to grow
-- large enough, and PostSearchAndFeaturedIT checks with EXPLAIN that it can still serve the @@ statement with the new configuration.
ALTER TABLE posts DROP COLUMN search_vector;

ALTER TABLE posts ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
        to_tsvector(
            'vi_unaccent',
            coalesce(title, '') || ' ' || coalesce(excerpt, '') || ' ' || coalesce(content, '')
        )
    ) STORED;

CREATE INDEX idx_posts_search_vector ON posts USING GIN (search_vector);
