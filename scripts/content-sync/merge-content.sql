-- Merges the staged content (schema export_content, restored by import-content.ps1) into the live tables.
-- Variables: update_mode (on|off), finish (COMMIT|ROLLBACK).
--
-- Rules, in the order they matter:
--  * Only content tables are touched. Users, comments, likes, bookmarks, views, subscribers and notifications are never read or written.
--  * Nothing is ever deleted. A post that exists only in the target stays; a tag removed in the source stays in the target
--    (except for the tag list of a post that the merge itself updates, which becomes the source's list).
--  * A row that already exists is changed only when update_mode is on AND the source row is newer (updated_at).
--  * The whole merge is one transaction. Any constraint violation (a slug taken by a different row, a featured rank in use...) rolls
--    everything back and names the row, so a half-merged site cannot happen.
--  * An author or uploader that is not a user of the target becomes the target's first ADMIN (or NULL where the column allows it).
\set ON_ERROR_STOP on
BEGIN;

SELECT set_config('cs.update', :'update_mode', true) AS configured \gset
CREATE TEMP TABLE cs_report (tbl text, inserted int NOT NULL DEFAULT 0, updated int NOT NULL DEFAULT 0, skipped int NOT NULL DEFAULT 0) ON COMMIT DROP;

-- The merge of one table: columns present in both the staged and the live table, never generated ones.
--   pk        primary key columns
--   ts        column that decides "newer" (NULL = insert only)
--   remap     columns that point at users: kept when the user exists, else the first ADMIN (NOT NULL columns) or NULL
--   leave_out columns written later (media.post_id is filled after the posts exist)
CREATE FUNCTION pg_temp.cs_merge(tbl text, pk text[], ts text, remap text[] DEFAULT '{}', leave_out text[] DEFAULT '{}') RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    cols text[];
    col text;
    sel text[] := '{}';
    sets text[] := '{}';
    expr text;
    nn boolean;
    pk_cond text;
    admin_id uuid;
    n_ins int := 0;
    n_upd int := 0;
    n_match int := 0;
BEGIN
    IF to_regclass(format('export_content.%I', tbl)) IS NULL THEN
        RETURN;
    END IF;
    SELECT id INTO admin_id FROM public.users WHERE role = 'ADMIN' ORDER BY created_at LIMIT 1;

    SELECT array_agg(quote_ident(a.attname) ORDER BY a.attnum) INTO cols
    FROM pg_attribute a
    WHERE a.attrelid = format('public.%I', tbl)::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
      AND NOT (a.attname = ANY (leave_out))
      AND EXISTS (SELECT 1 FROM pg_attribute s WHERE s.attrelid = format('export_content.%I', tbl)::regclass AND s.attname = a.attname AND NOT s.attisdropped);

    FOREACH col IN ARRAY cols LOOP
        expr := format('s.%s', col);
        IF trim(both '"' from col) = ANY (remap) THEN
            SELECT a.attnotnull INTO nn FROM pg_attribute a
            WHERE a.attrelid = format('public.%I', tbl)::regclass AND a.attname = trim(both '"' from col);
            expr := format('CASE WHEN s.%1$s IS NULL OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = s.%1$s) THEN s.%1$s ELSE %2$s END',
                           col, CASE WHEN nn THEN quote_nullable(admin_id) || '::uuid' ELSE 'NULL' END);
        END IF;
        sel := sel || expr;
        IF NOT (trim(both '"' from col) = ANY (pk)) THEN
            sets := sets || format('%s = %s', col, expr);
        END IF;
    END LOOP;

    SELECT string_agg(format('p.%1$I = s.%1$I', k), ' AND ') INTO pk_cond FROM unnest(pk) AS k;

    EXECUTE format('SELECT count(*) FROM export_content.%I s JOIN public.%I p ON %s', tbl, tbl, pk_cond) INTO n_match;

    EXECUTE format('INSERT INTO public.%I (%s) SELECT %s FROM export_content.%I s WHERE NOT EXISTS (SELECT 1 FROM public.%I p WHERE %s)',
                   tbl, array_to_string(cols, ', '), array_to_string(sel, ', '), tbl, tbl, pk_cond);
    GET DIAGNOSTICS n_ins = ROW_COUNT;

    IF ts IS NOT NULL AND current_setting('cs.update') = 'on' AND cardinality(sets) > 0 THEN
        EXECUTE format('UPDATE public.%I p SET %s FROM export_content.%I s WHERE %s AND s.%I > p.%I',
                       tbl, array_to_string(sets, ', '), tbl, pk_cond, ts, ts);
        GET DIAGNOSTICS n_upd = ROW_COUNT;
    END IF;

    INSERT INTO cs_report (tbl, inserted, updated, skipped) VALUES (tbl, n_ins, n_upd, greatest(n_match - n_upd, 0));
END
$$;

-- Lookups that need the state BEFORE the posts merge: which posts are new, which will be updated.
CREATE TEMP TABLE cs_post_new ON COMMIT DROP AS
    SELECT s.id FROM export_content.posts s WHERE NOT EXISTS (SELECT 1 FROM public.posts p WHERE p.id = s.id);
CREATE TEMP TABLE cs_post_upd ON COMMIT DROP AS
    SELECT s.id FROM export_content.posts s JOIN public.posts p ON p.id = s.id
    WHERE current_setting('cs.update') = 'on' AND s.updated_at > p.updated_at;

-- A slug is a post's current slug or the old slug of ANOTHER post, never both: the database refuses the second row (the triggers of
-- migration V50), and this check names the clash before any row is written instead of stopping the merge half way.
DO $$
DECLARE
    clash text;
BEGIN
    SELECT string_agg(c.slug, ', ') INTO clash FROM (
        SELECT s.slug FROM export_content.posts s
            JOIN public.post_slug_history h ON h.old_slug = s.slug AND h.post_id <> s.id
        UNION
        SELECT h.old_slug FROM export_content.post_slug_history h
            JOIN public.posts p ON p.slug = h.old_slug AND p.id <> h.post_id
        ORDER BY 1
        LIMIT 20
    ) c;
    IF clash IS NOT NULL THEN
        RAISE EXCEPTION 'slug clash: % is a current slug on one side and the old slug of another post on the other; nothing was merged', clash;
    END IF;
END
$$;

SELECT pg_temp.cs_merge('categories', '{id}', 'updated_at') AS merged \gset
SELECT pg_temp.cs_merge('tags', '{id}', NULL) AS merged \gset
SELECT pg_temp.cs_merge('series', '{id}', 'updated_at') AS merged \gset
SELECT pg_temp.cs_merge('media', '{id}', 'updated_at', '{uploaded_by}', '{post_id}') AS merged \gset
SELECT pg_temp.cs_merge('media_content', '{media_id}', NULL) AS merged \gset

-- Unique columns of a post (featured rank, series position and part) are freed first, so that two posts swapping places do not
-- collide in the middle of the statement. The series itself is cleared with them: a post cannot have a position without a series
-- (chk_posts_series_membership), and the merge writes all of them back in the next statement.
DO $$
DECLARE
    sets text;
BEGIN
    SELECT string_agg(quote_ident(attname) || ' = NULL', ', ') INTO sets
    FROM pg_attribute
    WHERE attrelid = 'public.posts'::regclass AND attname IN ('featured_rank', 'series_id', 'series_position', 'series_part') AND NOT attisdropped;
    IF sets IS NOT NULL THEN
        EXECUTE format('UPDATE public.posts SET %s WHERE id IN (SELECT id FROM cs_post_upd)', sets);
    END IF;
END
$$;
-- deleted_by (schema V49) is a foreign key to users like author_id: a post that an author of the source deleted keeps its hidden state,
-- and the person who did it becomes empty when the target has no such user (NULL, the column allows it).
SELECT pg_temp.cs_merge('posts', '{id}', 'updated_at', '{author_id,deleted_by}') AS merged \gset

-- A media row that was inserted without its post gets the link now (only an empty link is filled).
UPDATE public.media m SET post_id = s.post_id
FROM export_content.media s
WHERE m.id = s.id AND m.post_id IS NULL AND s.post_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.posts p WHERE p.id = s.post_id);

-- Tags of a post: new posts get the source's list; an updated post gets the source's list instead of its own.
DELETE FROM public.post_tags WHERE post_id IN (SELECT id FROM cs_post_upd);
INSERT INTO public.post_tags (post_id, tag_id)
SELECT s.post_id, s.tag_id FROM export_content.post_tags s
WHERE (s.post_id IN (SELECT id FROM cs_post_new) OR s.post_id IN (SELECT id FROM cs_post_upd))
  AND EXISTS (SELECT 1 FROM public.tags t WHERE t.id = s.tag_id)
ON CONFLICT DO NOTHING;
INSERT INTO cs_report (tbl, inserted) SELECT 'post_tags (of new or updated posts)', count(*) FROM export_content.post_tags s
WHERE s.post_id IN (SELECT id FROM cs_post_new) OR s.post_id IN (SELECT id FROM cs_post_upd);

-- Old addresses of a post keep working: added when missing.
INSERT INTO public.post_slug_history (old_slug, post_id, created_at)
SELECT s.old_slug, s.post_id, s.created_at FROM export_content.post_slug_history s
WHERE EXISTS (SELECT 1 FROM public.posts p WHERE p.id = s.post_id)
  AND NOT EXISTS (SELECT 1 FROM public.posts q WHERE q.slug = s.old_slug AND q.id <> s.post_id)
ON CONFLICT DO NOTHING;

SELECT pg_temp.cs_merge('post_revisions', '{id}', NULL, '{created_by}') AS merged \gset
SELECT pg_temp.cs_merge('gallery_photos', '{id}', 'updated_at') AS merged \gset
SELECT pg_temp.cs_merge('site_content', '{key,locale}', 'updated_at', '{updated_by}') AS merged \gset

-- Informational: posts that exist on the target but not in the package (never deleted by this merge). With a package made
-- from the full source this shows what was deleted at the source, or written only on the target.
\echo
\echo 'Posts only on the target (kept; delete them in the admin if they were removed at the source):'
SELECT p.slug, p.status FROM public.posts p WHERE NOT EXISTS (SELECT 1 FROM export_content.posts s WHERE s.id = p.id) ORDER BY p.slug;

\echo
\echo 'Gallery photos only on the target (kept):'
SELECT g.id, left(coalesce(g.caption, ''), 60) AS caption FROM public.gallery_photos g WHERE to_regclass('export_content.gallery_photos') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM export_content.gallery_photos s WHERE s.id = g.id) ORDER BY g.sort_order;

\echo
\echo 'Merge report (update_mode is checked above; ' :finish ' at the end):'
SELECT tbl AS "table", inserted, updated, skipped FROM cs_report ORDER BY tbl;

:finish;
