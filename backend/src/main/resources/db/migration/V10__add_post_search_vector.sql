-- Full-text search over the posts a reader can see.
--
-- PostgreSQL's own full-text search rather than anything external: this is a personal blog
-- with a dozen articles, and the spec rules out standing up a search cluster for it.
--
-- The 'simple' configuration, not a language configuration, and that is a deliberate
-- choice rather than a default. PostgreSQL ships no Vietnamese stemmer, so the only
-- alternatives were an English stemmer — which would conflate unrelated Vietnamese
-- syllables while helping nothing — or 'simple', which tokenises and folds case without
-- claiming to know the language. 'simple' still gives ranking and index support, which is
-- all the ranking a twelve-article blog can meaningfully use.
--
-- Known limitation, recorded rather than worked around: 'simple' does not strip
-- diacritics, so the unaccented "hoc" does not match its accented Vietnamese form. Removing that would mean the `unaccent`
-- extension, and `unaccent()` is STABLE rather than IMMUTABLE, so it cannot appear in a
-- generated column without wrapping it in a hand-written IMMUTABLE function — a
-- correctness hazard (the column would not be recomputed if the dictionary changed) for a
-- case that barely arises: ASCII technical terms carry no diacritics and so match either
-- way, and a reader searching Vietnamese types it with an IME, diacritics included.
ALTER TABLE posts ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
        to_tsvector(
            'simple',
            coalesce(title, '') || ' ' || coalesce(excerpt, '') || ' ' || coalesce(content, '')
        )
    ) STORED;

CREATE INDEX idx_posts_search_vector ON posts USING GIN (search_vector);
