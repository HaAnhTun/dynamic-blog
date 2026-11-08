package com.blog.sitecontent.repository;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * The tables {@code site_content} and {@code site_content_revision}. The jsonb column is read and written as text
 * (no JPA entity): the service parses and validates it, the database only stores it. Methods that write must run in
 * the caller's transaction.
 */
@Repository
@RequiredArgsConstructor
public class SiteContentRepository {

    /** How many revisions of one (key, locale) are kept. */
    public static final int KEPT_REVISIONS = 10;

    private static final String ROW_COLUMNS = "key, locale, schema_version, cast(data as text) as data, updated_at";

    private final JdbcTemplate jdbcTemplate;

    /** One current row; {@code data} is the stored JSON text. */
    public record Row(String key, String locale, int schemaVersion, String data, Instant updatedAt) {}

    /** One revision (the data of a row before a change); {@code data} is the stored JSON text. */
    public record Revision(long id, String key, String locale, int schemaVersion, String data, Instant createdAt) {}

    private static final RowMapper<Row> ROWS = (rs, i) -> new Row(
            rs.getString("key"),
            rs.getString("locale"),
            rs.getInt("schema_version"),
            rs.getString("data"),
            rs.getObject("updated_at", OffsetDateTime.class).toInstant());

    private static final RowMapper<Revision> REVISIONS = (rs, i) -> new Revision(
            rs.getLong("id"),
            rs.getString("key"),
            rs.getString("locale"),
            rs.getInt("schema_version"),
            rs.getString("data"),
            rs.getObject("created_at", OffsetDateTime.class).toInstant());

    public Optional<Row> find(String key, String locale) {
        return jdbcTemplate
                .query("select " + ROW_COLUMNS + " from site_content where key = ? and locale = ?", ROWS, key, locale)
                .stream()
                .findFirst();
    }

    /** Every row of the given locales (at most two in practice), in no particular order. */
    public List<Row> findByLocales(Collection<String> locales) {
        String marks = String.join(", ", locales.stream().map(l -> "?").toList());
        return jdbcTemplate.query(
                "select " + ROW_COLUMNS + " from site_content where locale in (" + marks + ")",
                ROWS,
                locales.toArray());
    }

    /** Serializes writers of one (key, locale) until the transaction ends, also when there is no row yet. */
    public void lock(String key, String locale) {
        jdbcTemplate.query(
                "select pg_advisory_xact_lock(hashtextextended(?, 0))",
                (RowCallbackHandler) rs -> {},
                "site-content:" + key + ":" + locale);
    }

    /** Copies the current row (if any) into a revision. Returns how many revisions were written (0 or 1). */
    public int snapshot(String key, String locale, UUID createdBy) {
        return jdbcTemplate.update("""
                insert into site_content_revision (key, locale, schema_version, data, created_by)
                select key, locale, schema_version, data, ? from site_content where key = ? and locale = ?""", createdBy, key, locale);
    }

    public void upsert(String key, String locale, int schemaVersion, String dataJson, UUID updatedBy) {
        jdbcTemplate.update("""
                insert into site_content (key, locale, schema_version, data, updated_at, updated_by)
                values (?, ?, ?, cast(? as jsonb), now(), ?)
                on conflict (key, locale) do update
                set schema_version = excluded.schema_version,
                    data = excluded.data,
                    updated_at = excluded.updated_at,
                    updated_by = excluded.updated_by""", key, locale, schemaVersion, dataJson, updatedBy);
    }

    /** Removes the current row of the pair (its revisions stay). Returns how many rows were removed (0 or 1). */
    public int delete(String key, String locale) {
        return jdbcTemplate.update("delete from site_content where key = ? and locale = ?", key, locale);
    }

    /** The id of the newest revision of the pair; right after {@link #snapshot} in the same transaction, that one. */
    public Optional<Long> latestRevisionId(String key, String locale) {
        return Optional.ofNullable(jdbcTemplate.queryForObject(
                "select max(id) from site_content_revision where key = ? and locale = ?", Long.class, key, locale));
    }

    /** Keeps the newest {@link #KEPT_REVISIONS} revisions of the pair. */
    public int pruneRevisions(String key, String locale) {
        return jdbcTemplate.update("""
                delete from site_content_revision
                where key = ? and locale = ?
                  and id not in (
                      select id from site_content_revision where key = ? and locale = ?
                      order by id desc limit ?)""", key, locale, key, locale, KEPT_REVISIONS);
    }

    /** Newest first, without the data. */
    public List<Revision> listRevisions(String key, String locale) {
        return jdbcTemplate.query("""
                select id, key, locale, schema_version, '{}' as data, created_at
                from site_content_revision where key = ? and locale = ?
                order by id desc limit ?""", REVISIONS, key, locale, KEPT_REVISIONS);
    }

    public Optional<Revision> findRevision(String key, String locale, long id) {
        return jdbcTemplate.query("""
                        select id, key, locale, schema_version, cast(data as text) as data, created_at
                        from site_content_revision where id = ? and key = ? and locale = ?""", REVISIONS, id, key, locale).stream().findFirst();
    }
}
