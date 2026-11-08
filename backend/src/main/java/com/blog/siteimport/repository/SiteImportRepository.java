package com.blog.siteimport.repository;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * The table {@code site_import_log}: one row per applied Markdown profile import. {@code sections} is a JSON array read
 * and written as text; it holds keys, statuses, revision ids, hashes and counts, never a value. Methods that write must
 * run in the caller's transaction.
 */
@Repository
@RequiredArgsConstructor
public class SiteImportRepository {

    private static final String COLUMNS = "id, created_at, locale, mode, cast(sections as text) as sections, undone_at";

    private final JdbcTemplate jdbcTemplate;

    /** One logged import; {@code sections} is the stored JSON array text. */
    public record LogRow(long id, Instant createdAt, String locale, String mode, String sections, Instant undoneAt) {

        public boolean undone() {
            return undoneAt != null;
        }
    }

    private static final RowMapper<LogRow> ROWS = (rs, i) -> {
        OffsetDateTime undoneAt = rs.getObject("undone_at", OffsetDateTime.class);
        return new LogRow(
                rs.getLong("id"),
                rs.getObject("created_at", OffsetDateTime.class).toInstant(),
                rs.getString("locale"),
                rs.getString("mode"),
                rs.getString("sections"),
                undoneAt == null ? null : undoneAt.toInstant());
    };

    /** Serializes every import and undo of the whole site until the transaction ends. */
    public void lockGlobal() {
        jdbcTemplate.query(
                "select pg_advisory_xact_lock(hashtextextended(?, 0))", (RowCallbackHandler) rs -> {}, "site-import");
    }

    public long insert(
            UUID createdBy, String locale, String mode, String fileSha256, int fileBytes, String sectionsJson) {
        Long id = jdbcTemplate.queryForObject(
                """
                insert into site_import_log (created_by, locale, mode, file_sha256, file_bytes, sections)
                values (?, ?, ?, ?, ?, cast(? as jsonb))
                returning id""", Long.class, createdBy, locale, mode, fileSha256, fileBytes, sectionsJson);
        if (id == null) {
            throw new IllegalStateException("the import log row has no id");
        }
        return id;
    }

    /** The newest import, undone or not. */
    public Optional<LogRow> findLatest() {
        return jdbcTemplate.query("select " + COLUMNS + " from site_import_log order by id desc limit 1", ROWS).stream()
                .findFirst();
    }

    /** The newest import that is not undone and wrote at least one section (created or updated). */
    public Optional<LogRow> findLatestUndoable() {
        return jdbcTemplate
                .query(
                        "select " + COLUMNS + " from site_import_log where undone_at is null and exists ("
                                + "select 1 from jsonb_array_elements(sections) s "
                                + "where s ->> 'status' in ('created', 'updated')) order by id desc limit 1",
                        ROWS)
                .stream()
                .findFirst();
    }

    public void markUndone(long id, UUID undoneBy) {
        jdbcTemplate.update("update site_import_log set undone_at = now(), undone_by = ? where id = ?", undoneBy, id);
    }
}
