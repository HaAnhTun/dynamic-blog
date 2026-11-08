package com.blog.search.sync;

import com.blog.search.index.DocType;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Collection;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * SQL of the search outbox worker (V33). Timestamps come from the worker's clock, not from the DB {@code now()}, so tests
 * can push the retry schedule forward. Every statement that ends a pass only touches rows that still carry that pass's
 * exact lease deadline ({@code locked_until}): a pass that ran past its deadline and was claimed again by another pass
 * cannot overwrite the result of the newer pass.
 */
@Repository
public class SearchOutboxRepository {

    /** A row just claimed; {@code taskUid} is the task already submitted in an earlier pass (poll it again, do not resend), null when not yet submitted. */
    public record Claimed(long id, DocType type, String sourceId, int attempts, Long taskUid) {

        public String documentId() {
            return type.documentId(sourceId);
        }
    }

    private static final String CLAIM = """
            UPDATE search_outbox SET state = 'PROCESSING', locked_until = ?, updated_at = ?
            WHERE id IN (SELECT id FROM search_outbox
                         WHERE (state = 'PENDING' AND next_attempt_at <= ?)
                            OR (state = 'PROCESSING' AND locked_until <= ?)
                         ORDER BY next_attempt_at, id
                         LIMIT ? FOR UPDATE SKIP LOCKED)
            RETURNING id, doc_type, source_id, attempts, task_uid""";
    private static final String OWNED = "id = ANY (CAST(? AS bigint[])) AND state = 'PROCESSING' AND locked_until = ?";
    /** Wait before attempt n+1, with n = attempts after this failure: FIRST·2^(n-1), at most MAX (seconds). */
    private static final String BACKOFF =
            "make_interval(secs => LEAST(CAST(? AS float8) * power(2, %s - 1), CAST(? AS float8)))";
    /**
     * A failed row becomes a NEW pending (or FAILED) row through ON CONFLICT DO NOTHING: if a change already created a
     * pending row for the same document while it was being processed, that row already covers this work and the failed
     * row simply disappears. It cannot race with a parallel write.
     */
    private static final String FAIL = """
            WITH gone AS (
                DELETE FROM search_outbox WHERE %s
                RETURNING doc_type, source_id, attempts + 1 AS attempts, created_at)
            INSERT INTO search_outbox (doc_type, source_id, state, attempts, next_attempt_at, last_error_code,
                                       created_at, updated_at)
            SELECT DISTINCT ON (doc_type, source_id) doc_type, source_id,
                   CASE WHEN attempts >= ? THEN 'FAILED' ELSE 'PENDING' END, attempts, CAST(? AS timestamptz) + %s,
                   ?, created_at, ?
            FROM gone
            ORDER BY doc_type, source_id, attempts DESC
            ON CONFLICT (doc_type, source_id) WHERE state IN ('PENDING', 'FAILED') DO NOTHING""".formatted(OWNED, BACKOFF.formatted("attempts"));
    /** A task submitted but with unknown result: keep PROCESSING and the task_uid, the lease becomes the time to poll again. */
    private static final String KEEP_WAITING = """
            UPDATE search_outbox SET attempts = attempts + 1, locked_until = CAST(? AS timestamptz) + %s,
                   last_error_code = ?, updated_at = ?
            WHERE %s AND task_uid IS NOT NULL AND attempts + 1 < ?""".formatted(BACKOFF.formatted("(attempts + 1)"), OWNED);

    private final JdbcTemplate jdbcTemplate;

    public SearchOutboxRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /**
     * Claims at most {@code limit} rows that are due, or PROCESSING rows whose lease expired, then marks them PROCESSING
     * until {@code leaseUntil}. {@code SKIP LOCKED}: two workers never claim the same row.
     */
    public List<Claimed> claim(Instant now, Instant leaseUntil, int limit) {
        return jdbcTemplate.query(
                CLAIM,
                (rs, row) -> new Claimed(
                        rs.getLong("id"),
                        DocType.of(rs.getString("doc_type")).orElseThrow(),
                        rs.getString("source_id"),
                        rs.getInt("attempts"),
                        rs.getObject("task_uid", Long.class)),
                at(leaseUntil),
                at(now),
                at(now),
                at(now),
                limit);
    }

    /** Records the task just submitted on the rows, before waiting for it. */
    public int recordTask(Collection<Long> ids, Instant lease, long taskUid, Instant now) {
        return jdbcTemplate.update(
                "UPDATE search_outbox SET task_uid = ?, updated_at = ? WHERE " + OWNED,
                taskUid,
                at(now),
                ids(ids),
                at(lease));
    }

    /** Synced: delete the rows. A new pending row for the same document (a change during processing) stays. */
    public int delete(Collection<Long> ids, Instant lease) {
        return jdbcTemplate.update("DELETE FROM search_outbox WHERE " + OWNED, ids(ids), at(lease));
    }

    /**
     * Failed: attempts+1, wait per {@link #BACKOFF}, or FAILED when attempts reach {@code maxAttempts}; the task_uid is
     * dropped, so the next attempt resubmits from the DB.
     */
    public int fail(
            Collection<Long> ids,
            Instant lease,
            String code,
            Instant now,
            Duration first,
            Duration max,
            int maxAttempts) {
        return jdbcTemplate.update(
                FAIL, ids(ids), at(lease), maxAttempts, at(now), seconds(first), seconds(max), code, at(now));
    }

    /**
     * The engine did not answer while waiting for a submitted task: poll that same task again after a backoff, do not
     * resubmit. Rows that are out of attempts are not touched here: {@link #fail} afterwards moves them to FAILED.
     */
    public int keepWaiting(
            Collection<Long> ids,
            Instant lease,
            String code,
            Instant now,
            Duration first,
            Duration max,
            int maxAttempts) {
        return jdbcTemplate.update(
                KEEP_WAITING, at(now), seconds(first), seconds(max), code, at(now), ids(ids), at(lease), maxAttempts);
    }

    /**
     * Row counts by status, for the status page and the reindex dry run.
     *
     * @param oldestPendingCreatedAt when the oldest still-pending change was first written ({@code created_at} is kept
     *                               through every retry); null when there is no PENDING row
     */
    public record Stats(long pending, long processing, long failed, Instant oldestPendingCreatedAt) {}

    public Stats stats() {
        return jdbcTemplate.queryForObject("""
                SELECT count(*) FILTER (WHERE state = 'PENDING') AS pending,
                       count(*) FILTER (WHERE state = 'PROCESSING') AS processing,
                       count(*) FILTER (WHERE state = 'FAILED') AS failed,
                       min(created_at) FILTER (WHERE state = 'PENDING') AS oldest
                FROM search_outbox""", (rs, row) -> {
            Timestamp oldest = rs.getTimestamp("oldest");
            return new Stats(
                    rs.getLong("pending"),
                    rs.getLong("processing"),
                    rs.getLong("failed"),
                    oldest == null ? null : oldest.toInstant());
        });
    }

    /**
     * Deletes FAILED rows whose last failure is at or before {@code before}: a complete reconcile pass that started at
     * {@code before} has re-read the DB after their changes and brought the index right. Rows that failed later (newer changes) stay.
     *
     * @return number of rows deleted
     */
    public int resolveFailed(Instant before) {
        return jdbcTemplate.update("DELETE FROM search_outbox WHERE state = 'FAILED' AND updated_at <= ?", at(before));
    }

    private static Long[] ids(Collection<Long> ids) {
        return ids.toArray(Long[]::new);
    }

    private static double seconds(Duration duration) {
        return duration.toMillis() / 1000.0;
    }

    private static OffsetDateTime at(Instant instant) {
        return OffsetDateTime.ofInstant(instant, ZoneOffset.UTC);
    }
}
