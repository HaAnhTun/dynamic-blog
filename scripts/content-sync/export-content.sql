-- Copies the CONTENT tables of the blog into a throw-away schema `export_content`, so pg_dump can pack them.
-- Run by export-content.ps1 inside the source database. Variables: only_published (on|off), with_revisions (on|off).
-- Nothing here touches users, comments, likes, bookmarks, views, subscribers, notifications or any other reader data.
\set ON_ERROR_STOP on

DROP SCHEMA IF EXISTS export_content CASCADE;
CREATE SCHEMA export_content;

-- Copies a table with every column that is not generated (search_vector is rebuilt by the target database).
CREATE FUNCTION pg_temp.cs_copy(tbl text, filter text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $$
DECLARE
    cols text;
BEGIN
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO cols
    FROM pg_attribute a
    WHERE a.attrelid = format('public.%I', tbl)::regclass AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '';
    EXECUTE format('CREATE TABLE export_content.%I AS SELECT %s FROM public.%I %s', tbl, cols, tbl, filter);
END
$$;

SELECT pg_temp.cs_copy('categories');
SELECT pg_temp.cs_copy('tags');
SELECT pg_temp.cs_copy('series');
SELECT pg_temp.cs_copy('media');
SELECT pg_temp.cs_copy('media_content');

\if :only_published
SELECT pg_temp.cs_copy('posts', $f$ WHERE status = 'PUBLISHED' $f$);
SELECT pg_temp.cs_copy('post_tags', $f$ WHERE post_id IN (SELECT id FROM export_content.posts) $f$);
SELECT pg_temp.cs_copy('post_slug_history', $f$ WHERE post_id IN (SELECT id FROM export_content.posts) $f$);
\else
SELECT pg_temp.cs_copy('posts');
SELECT pg_temp.cs_copy('post_tags');
SELECT pg_temp.cs_copy('post_slug_history');
\endif

\if :with_revisions
SELECT pg_temp.cs_copy('post_revisions', $f$ WHERE post_id IN (SELECT id FROM export_content.posts) $f$);
\endif

SELECT pg_temp.cs_copy('gallery_photos');
SELECT pg_temp.cs_copy('site_content');

-- One line per staged table: name and row count (the PowerShell script reads this into the manifest).
SELECT format('%s|%s', c.relname, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM export_content.%I', c.relname), false, true, '')))[1]::text)
FROM pg_class c WHERE c.relnamespace = 'export_content'::regnamespace AND c.relkind = 'r' ORDER BY c.relname;
