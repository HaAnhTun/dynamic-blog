package com.blog.search.sync;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.search.config.SearchProperties;
import com.blog.search.index.DocType;
import com.blog.search.sync.SearchOutboxRepository.Claimed;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.HeldTransaction;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * V33 and the search outbox SQL on a database of its own (Flyway up to V33), no Spring context: constraints, event
 * merging, claiming a batch with SKIP LOCKED, lease expiry, backoff, FAILED, and two writes of the same document
 * running in parallel. Fan-out across categories, tags, series, authors and the worker on a real Meilisearch is in
 * SearchOutboxIT.
 */
class SearchOutboxMigrationIT {

    private static final Instant T0 = Instant.parse("2026-10-11T08:00:00Z");
    private static final Duration FIRST = Duration.ofSeconds(30);
    private static final Duration MAX = Duration.ofMinutes(30);

    private static DataSource dataSource;
    private static JdbcTemplate jdbc;
    private static DataSourceTransactionManager transactionManager;

    private final TestClock clock = new TestClock();
    private SearchOutbox outbox;
    private SearchOutboxRepository repository;

    /** A manually advanced clock, microsecond precision like timestamptz. */
    static final class TestClock extends Clock {
        private Instant now = T0;

        void set(Instant instant) {
            now = instant;
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }

    @BeforeAll
    static void migrate() {
        dataSource = AbstractIntegrationTest.freshDataSource("search_outbox_migration_it");
        Flyway.configure().dataSource(dataSource).target("33").load().migrate();
        jdbc = new JdbcTemplate(dataSource);
        transactionManager = new DataSourceTransactionManager(dataSource);
    }

    @BeforeEach
    void cleanSlate() {
        jdbc.update("DELETE FROM search_outbox");
        clock.set(T0);
        SearchProperties properties = new SearchProperties(
                SearchProperties.Engine.POSTGRES,
                new SearchProperties.Meili(
                        "http://meili.invalid:7700",
                        "",
                        "content_v1",
                        Duration.ofMillis(500),
                        Duration.ofMillis(800),
                        Duration.ofSeconds(10)));
        outbox = new SearchOutbox(jdbc, properties, clock);
        repository = new SearchOutboxRepository(jdbc);
    }

    // --- V33 ---------------------------------------------------------------------------------------------

    @Test
    void V33_rejects_bad_id_type_status_lease_task_error_code_and_allows_one_pending_or_failed_row_per_document() {
        String post = UUID.randomUUID().toString();
        insert("post", post, "PENDING", null, null, null);
        insert("page", "about", "PENDING", null, null, null);
        insert("case-study", "blog-hai-service-mot-vps", "PENDING", null, null, null);
        insert("author", UUID.randomUUID().toString(), "PROCESSING", T0, 42L, "TASK_TIMEOUT");
        insert("tag", UUID.randomUUID().toString(), "FAILED", null, null, "CONNECTION_FAILED");

        assertRejected("comment", UUID.randomUUID().toString(), "PENDING", null, null, null);
        assertRejected("Post", UUID.randomUUID().toString(), "PENDING", null, null, null);
        assertRejected("post", "about", "PENDING", null, null, null);
        assertRejected("post", UUID.randomUUID().toString().toUpperCase(), "PENDING", null, null, null);
        assertRejected("page", "a/b", "PENDING", null, null, null);
        assertRejected("page", "a b", "PENDING", null, null, null);
        assertRejected("page", "", "PENDING", null, null, null);
        assertRejected("post", UUID.randomUUID().toString(), "DONE", null, null, null);
        // A lease expiry exists if and only if the row is being processed; a task only during that time.
        assertRejected("post", UUID.randomUUID().toString(), "PROCESSING", null, null, null);
        assertRejected("post", UUID.randomUUID().toString(), "PENDING", T0, null, null);
        assertRejected("post", UUID.randomUUID().toString(), "PENDING", null, 7L, null);
        assertRejected("post", UUID.randomUUID().toString(), "PROCESSING", T0, -1L, null);
        // FAILED always has a code; the code is only uppercase letters and underscores, never a message.
        assertRejected("post", UUID.randomUUID().toString(), "FAILED", null, null, null);
        assertRejected("post", UUID.randomUUID().toString(), "FAILED", null, null, "connection refused");
        assertRejected("post", UUID.randomUUID().toString(), "PENDING", null, null, "A".repeat(33));
        assertThatThrownBy(() -> jdbc.update(
                        "INSERT INTO search_outbox (doc_type, source_id, attempts, "
                                + "next_attempt_at) VALUES ('post', ?, -1, now())",
                        UUID.randomUUID().toString()))
                .isInstanceOf(DataIntegrityViolationException.class);

        // Partial unique index: one pending OR failed row per document; a row being processed is outside it.
        assertRejected("post", post, "PENDING", null, null, null);
        assertRejected("post", post, "FAILED", null, null, "TIMEOUT");
        insert("post", post, "PROCESSING", T0, null, null);
        insert("post", post, "PROCESSING", T0, null, null);
        insert("tag", post, "PENDING", null, null, null);
        assertThat(count("post", post)).isEqualTo(3);
    }

    // --- Merging ----------------------------------------------------------------------------------------------

    @Test
    void
            repeated_writes_merge_into_one_pending_row_keep_backoff_reopen_failed_row_and_do_not_swallow_changes_during_processing() {
        UUID post = UUID.randomUUID();
        outbox.enqueue(DocType.POST, post);
        clock.set(T0.plusSeconds(5));
        // A duplicate within the same statement is fine too (DISTINCT before ON CONFLICT DO UPDATE).
        outbox.enqueue(DocType.POST, List.of(post, post));
        outbox.enqueue(DocType.TAG, post);
        assertThat(rows("post", post)).singleElement().satisfies(row -> {
            assertThat(row.get("state")).isEqualTo("PENDING");
            assertThat(instant(row.get("next_attempt_at"))).isEqualTo(T0);
            assertThat(instant(row.get("updated_at"))).isEqualTo(T0.plusSeconds(5));
        });
        assertThat(count("tag", post)).isEqualTo(1);

        // Being processed: a new change becomes a separate pending row. When done, only the claimed row is deleted.
        Instant lease = T0.plus(Duration.ofMinutes(5));
        List<Claimed> claimed = claim(T0.plusSeconds(5), lease, 10);
        assertThat(claimed).extracting(Claimed::documentId).containsExactlyInAnyOrder("post-" + post, "tag-" + post);
        outbox.enqueue(DocType.POST, post);
        assertThat(states("post", post)).containsExactlyInAnyOrder("PROCESSING", "PENDING");
        inTransaction(() -> repository.delete(ids(claimed), lease));
        assertThat(states("post", post)).containsExactly("PENDING");
        assertThat(count("tag", post)).isZero();

        // A pending row in backoff: a new write does not reset the attempt count or the schedule.
        jdbc.update(
                "UPDATE search_outbox SET attempts = 3, next_attempt_at = ?, last_error_code = 'TIMEOUT'"
                        + " WHERE source_id = ?",
                Timestamp.from(T0.plus(Duration.ofMinutes(4))),
                post.toString());
        clock.set(T0.plusSeconds(60));
        outbox.enqueue(DocType.POST, post);
        assertThat(rows("post", post)).singleElement().satisfies(row -> {
            assertThat(row.get("attempts")).isEqualTo(3);
            assertThat(instant(row.get("next_attempt_at"))).isEqualTo(T0.plus(Duration.ofMinutes(4)));
            assertThat(row.get("last_error_code")).isEqualTo("TIMEOUT");
        });

        // FAILED: a new change gives the document a fresh chance, immediately.
        jdbc.update(
                "UPDATE search_outbox SET state = 'FAILED', attempts = 10, last_error_code = 'TASK_FAILED'"
                        + " WHERE source_id = ?",
                post.toString());
        clock.set(T0.plusSeconds(90));
        outbox.enqueue(DocType.POST, post);
        assertThat(rows("post", post)).singleElement().satisfies(row -> {
            assertThat(row.get("state")).isEqualTo("PENDING");
            assertThat(row.get("attempts")).isEqualTo(0);
            assertThat(row.get("last_error_code")).isNull();
            assertThat(instant(row.get("next_attempt_at"))).isEqualTo(T0.plusSeconds(90));
        });
    }

    @Test
    void indexing_off_writes_nothing() {
        SearchOutbox off = new SearchOutbox(
                jdbc,
                new SearchProperties(
                        SearchProperties.Engine.MEILISEARCH,
                        new SearchProperties.Meili(
                                "",
                                "key",
                                "content_v1",
                                Duration.ofMillis(500),
                                Duration.ofMillis(800),
                                Duration.ofSeconds(10))),
                clock);
        off.enqueue(DocType.POST, UUID.randomUUID());
        off.publishedPostsInCategory(UUID.randomUUID());
        assertThat(jdbc.queryForObject("SELECT count(*) FROM search_outbox", Integer.class))
                .isZero();
    }

    // --- Worker -------------------------------------------------------------------------------------------

    @Test
    void claiming_batch_is_capped_failure_doubles_backoff_to_failed_and_old_lease_writes_nothing() {
        UUID a = UUID.randomUUID();
        UUID b = UUID.randomUUID();
        UUID c = UUID.randomUUID();
        outbox.enqueue(DocType.POST, List.of(a, b, c));
        Instant lease = T0.plus(Duration.ofMinutes(5));
        assertThat(claim(T0.minusSeconds(1), lease, 10)).as("not due yet").isEmpty();
        List<Claimed> first = claim(T0, lease, 2);
        assertThat(first).hasSize(2).allSatisfy(row -> {
            assertThat(row.attempts()).isZero();
            assertThat(row.taskUid()).isNull();
        });
        List<Claimed> last = claim(T0, lease, 10);
        assertThat(last).hasSize(1);
        assertThat(claim(T0, lease, 10)).as("still held").isEmpty();

        Claimed row = first.getFirst();
        UUID id = UUID.fromString(row.sourceId());
        // A different lease expiry (an overdue pass, the row was claimed again) overwrites nothing.
        inTransaction(() -> {
            assertThat(repository.delete(List.of(row.id()), lease.plusSeconds(1)))
                    .isZero();
            repository.fail(List.of(row.id()), lease.plusSeconds(1), "TIMEOUT", T0, FIRST, MAX, 10);
        });
        assertThat(states("post", id)).containsExactly("PROCESSING");
        inTransaction(() -> assertThat(repository.delete(
                        List.of(first.get(1).id(), last.getFirst().id()), lease))
                .isEqualTo(2));

        // Backoff: 30 seconds, doubling each time, capped at 30 minutes; the 10th attempt is FAILED.
        Instant now = T0;
        Instant currentLease = lease;
        long previousId = row.id();
        for (int attempt = 1; attempt <= 10; attempt++) {
            Instant at = now;
            Instant held = currentLease;
            long rowId = previousId;
            inTransaction(() -> repository.fail(List.of(rowId), held, "CONNECTION_FAILED", at, FIRST, MAX, 10));
            Map<String, Object> failed = rows("post", id).getFirst();
            assertThat(failed.get("attempts")).isEqualTo(attempt);
            assertThat(failed.get("last_error_code")).isEqualTo("CONNECTION_FAILED");
            assertThat(failed.get("locked_until")).isNull();
            if (attempt == 10) {
                assertThat(failed.get("state")).isEqualTo("FAILED");
                break;
            }
            long wait = Math.min(30L << (attempt - 1), 1800L);
            assertThat(failed.get("state")).isEqualTo("PENDING");
            assertThat(instant(failed.get("next_attempt_at"))).isEqualTo(at.plusSeconds(wait));
            assertThat(claim(at.plusSeconds(wait - 1), at.plusSeconds(wait + 300), 10))
                    .isEmpty();
            now = at.plusSeconds(wait);
            currentLease = now.plus(Duration.ofMinutes(5));
            List<Claimed> again = claim(now, currentLease, 10);
            int expected = attempt;
            assertThat(again)
                    .singleElement()
                    .satisfies(r -> assertThat(r.attempts()).isEqualTo(expected));
            previousId = again.getFirst().id();
        }
        assertThat(claim(now.plus(Duration.ofDays(1)), now.plus(Duration.ofDays(2)), 10))
                .as("FAILED is not claimed")
                .isEmpty();
    }

    @Test
    void
            sent_task_is_recorded_and_after_expiry_that_task_is_polled_again_and_unanswered_engine_keeps_task_until_attempts_run_out() {
        UUID post = UUID.randomUUID();
        outbox.enqueue(DocType.POST, post);
        Instant lease = T0.plus(Duration.ofMinutes(5));
        Claimed row = claim(T0, lease, 10).getFirst();
        inTransaction(() -> assertThat(repository.recordTask(List.of(row.id()), lease, 77L, T0))
                .isEqualTo(1));

        // Worker died: once the lease expires the next pass claims the row again, with the task already sent.
        assertThat(claim(lease.minusSeconds(1), lease.plusSeconds(300), 10)).isEmpty();
        Instant lease2 = lease.plus(Duration.ofMinutes(5));
        Claimed resumed = claim(lease, lease2, 10).getFirst();
        assertThat(resumed.id()).isEqualTo(row.id());
        assertThat(resumed.taskUid()).isEqualTo(77L);

        // The engine does not answer the task poll: keep PROCESSING and the task, poll again after the backoff.
        inTransaction(() -> {
            assertThat(repository.keepWaiting(List.of(row.id()), lease2, "TIMEOUT", lease, FIRST, MAX, 2))
                    .isEqualTo(1);
            repository.fail(List.of(row.id()), lease2, "TIMEOUT", lease, FIRST, MAX, 2);
        });
        assertThat(rows("post", post)).singleElement().satisfies(r -> {
            assertThat(r.get("state")).isEqualTo("PROCESSING");
            assertThat(r.get("task_uid")).isEqualTo(77L);
            assertThat(r.get("attempts")).isEqualTo(1);
            assertThat(instant(r.get("locked_until"))).isEqualTo(lease.plusSeconds(30));
        });
        Instant lease3 = lease.plus(Duration.ofMinutes(10));
        Claimed third = claim(lease.plusSeconds(30), lease3, 10).getFirst();
        assertThat(third.taskUid()).isEqualTo(77L);
        // Out of attempts: no longer kept, FAILED, task dropped.
        inTransaction(() -> {
            assertThat(repository.keepWaiting(List.of(third.id()), lease3, "TIMEOUT", lease, FIRST, MAX, 2))
                    .isZero();
            repository.fail(List.of(third.id()), lease3, "TIMEOUT", lease, FIRST, MAX, 2);
        });
        assertThat(rows("post", post)).singleElement().satisfies(r -> {
            assertThat(r.get("state")).isEqualTo("FAILED");
            assertThat(r.get("task_uid")).isNull();
        });
    }

    @Test
    void failed_row_with_a_new_pending_row_of_same_document_merges_into_that_row() {
        UUID post = UUID.randomUUID();
        outbox.enqueue(DocType.POST, post);
        Instant lease = T0.plus(Duration.ofMinutes(5));
        Claimed row = claim(T0, lease, 10).getFirst();
        clock.set(T0.plusSeconds(1));
        outbox.enqueue(DocType.POST, post);
        inTransaction(() -> repository.fail(List.of(row.id()), lease, "SERVER_ERROR", T0, FIRST, MAX, 10));
        assertThat(rows("post", post)).singleElement().satisfies(r -> {
            assertThat(r.get("state")).isEqualTo("PENDING");
            assertThat(r.get("attempts")).isEqualTo(0);
            assertThat(instant(r.get("next_attempt_at"))).isEqualTo(T0.plusSeconds(1));
        });
    }

    // --- Concurrency ------------------------------------------------------------------------------------------

    @Test
    void two_claims_never_take_the_same_row_and_do_not_wait_for_each_other() throws Exception {
        UUID a = UUID.randomUUID();
        UUID b = UUID.randomUUID();
        outbox.enqueue(DocType.POST, List.of(a, b));
        Instant lease = T0.plus(Duration.ofMinutes(5));
        List<Claimed> held = new CopyOnWriteArrayList<>();
        try (HeldTransaction first = new HeldTransaction(
                transactionManager, jdbc, template -> held.addAll(repository.claim(T0, lease, 1)))) {
            assertThat(held).hasSize(1);
            // The other row, immediately: SKIP LOCKED skips a locked row instead of waiting for it.
            List<Claimed> second =
                    new TransactionTemplate(transactionManager).execute(status -> repository.claim(T0, lease, 10));
            assertThat(second)
                    .singleElement()
                    .satisfies(row ->
                            assertThat(row.id()).isNotEqualTo(held.getFirst().id()));
            first.commit();
        }
        assertThat(jdbc.queryForObject("SELECT count(*) FROM search_outbox WHERE state = 'PROCESSING'", Integer.class))
                .isEqualTo(2);
    }

    @Test
    void two_transactions_writing_same_document_at_once_still_give_one_row() throws Exception {
        UUID post = UUID.randomUUID();
        ExecutorService other = Executors.newSingleThreadExecutor();
        try (HeldTransaction first =
                new HeldTransaction(transactionManager, jdbc, template -> outbox.enqueue(DocType.POST, post))) {
            Future<?> second = other.submit(() -> new TransactionTemplate(transactionManager)
                    .executeWithoutResult(status -> outbox.enqueue(DocType.POST, post)));
            HeldTransaction.awaitWaitingOnLock(jdbc, "INSERT INTO search_outbox", 1);
            first.commit();
            second.get(30, TimeUnit.SECONDS);
        } finally {
            other.shutdownNow();
        }
        assertThat(states("post", post)).containsExactly("PENDING");
    }

    // --- Helpers ----------------------------------------------------------------------------------------------

    private List<Claimed> claim(Instant now, Instant lease, int limit) {
        return new TransactionTemplate(transactionManager).execute(status -> repository.claim(now, lease, limit));
    }

    private void inTransaction(Runnable work) {
        new TransactionTemplate(transactionManager).executeWithoutResult(status -> work.run());
    }

    private static List<Long> ids(List<Claimed> rows) {
        return rows.stream().map(Claimed::id).toList();
    }

    private static void insert(
            String type, String source, String state, Instant lockedUntil, Long taskUid, String code) {
        jdbc.update(
                "INSERT INTO search_outbox (doc_type, source_id, state, next_attempt_at, locked_until, task_uid, "
                        + "last_error_code) VALUES (?, ?, ?, now(), ?, ?, ?)",
                type,
                source,
                state,
                lockedUntil == null ? null : Timestamp.from(lockedUntil),
                taskUid,
                code);
    }

    private static void assertRejected(
            String type, String source, String state, Instant lockedUntil, Long taskUid, String code) {
        assertThatThrownBy(() -> insert(type, source, state, lockedUntil, taskUid, code))
                .as("%s %s %s %s %s %s", type, source, state, lockedUntil, taskUid, code)
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    private static int count(String type, Object source) {
        return jdbc.queryForObject(
                "SELECT count(*) FROM search_outbox WHERE doc_type = ? AND source_id = ?",
                Integer.class,
                type,
                source.toString());
    }

    private static List<String> states(String type, Object source) {
        return jdbc.queryForList(
                "SELECT state FROM search_outbox WHERE doc_type = ? AND source_id = ?",
                String.class,
                type,
                source.toString());
    }

    private static List<Map<String, Object>> rows(String type, Object source) {
        return jdbc.queryForList(
                "SELECT * FROM search_outbox WHERE doc_type = ? AND source_id = ?", type, source.toString());
    }

    private static Instant instant(Object timestamp) {
        return ((Timestamp) timestamp).toInstant();
    }
}
