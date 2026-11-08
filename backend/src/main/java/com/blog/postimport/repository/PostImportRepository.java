package com.blog.postimport.repository;

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
 * The table {@code post_import_log}: one row per applied Markdown post import. {@code items} is a JSON array read and written
 * as text; it holds identifiers, hashes and counts, never text from a file or a post. Methods that write must run in the
 * caller's transaction.
 */
@Repository
@RequiredArgsConstructor
public class PostImportRepository {

    private static final String COLUMNS = "id, created_at, file_count, cast(items as text) as items, undone_at";

    private final JdbcTemplate jdbcTemplate;

    /** One logged import; {@code items} is the stored JSON array text. */
    public record LogRow(long id, Instant createdAt, int fileCount, String items, Instant undoneAt) {

        public boolean undone() {
            return undoneAt != null;
        }
    }

    private static final RowMapper<LogRow> ROWS = (rs, i) -> {
        OffsetDateTime undoneAt = rs.getObject("undone_at", OffsetDateTime.class);
        return new LogRow(
                rs.getLong("id"),
                rs.getObject("created_at", OffsetDateTime.class).toInstant(),
                rs.getInt("file_count"),
                rs.getString("items"),
                undoneAt == null ? null : undoneAt.toInstant());
    };

    /** Serializes every post import and undo of the whole site until the transaction ends. */
    public void lockGlobal() {
        jdbcTemplate.query(
                "select pg_advisory_xact_lock(hashtextextended(?, 0))", (RowCallbackHandler) rs -> {}, "post-import");
    }

    /**
     * The id of the post whose current slug this is. Reads the id only, never the entity: the caller locks the post row next and
     * must then read the post as it is under that lock, not as a persistence context loaded earlier remembers it.
     */
    public Optional<UUID> findPostIdBySlug(String slug) {
        return jdbcTemplate
                .query("select id from posts where slug = ?", (rs, i) -> rs.getObject("id", UUID.class), slug)
                .stream()
                .findFirst();
    }

    public long insert(UUID createdBy, int fileCount, int fileBytes, String fileHashesJson, String itemsJson) {
        Long id = jdbcTemplate.queryForObject(
                """
                insert into post_import_log (created_by, file_count, file_bytes, file_hashes, items)
                values (?, ?, ?, cast(? as jsonb), cast(? as jsonb))
                returning id""", Long.class, createdBy, fileCount, fileBytes, fileHashesJson, itemsJson);
        if (id == null) {
            throw new IllegalStateException("the post import log row has no id");
        }
        return id;
    }

    /** The newest import of this person, undone or not. Nobody else's import is ever returned. */
    public Optional<LogRow> findLatestOf(UUID createdBy) {
        return jdbcTemplate
                .query(
                        "select " + COLUMNS + " from post_import_log where created_by = ? order by id desc limit 1",
                        ROWS,
                        createdBy)
                .stream()
                .findFirst();
    }
}
