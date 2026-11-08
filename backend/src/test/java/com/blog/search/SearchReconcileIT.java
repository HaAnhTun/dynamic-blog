package com.blog.search;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.search.config.SearchProperties;
import com.blog.search.index.DocType;
import com.blog.search.index.SearchDocument;
import com.blog.search.index.SearchDocumentSource;
import com.blog.search.index.SearchIndexer;
import com.blog.search.meili.MeiliHttpClient;
import com.blog.search.meili.MeiliKeys;
import com.blog.search.service.SearchMetrics;
import com.blog.search.service.StaticSearchContent;
import com.blog.search.sync.ReconcileReport;
import com.blog.search.sync.ReconcileReport.Outcome;
import com.blog.search.sync.SearchOutbox;
import com.blog.search.sync.SearchOutboxRepository;
import com.blog.search.sync.SearchOutboxWorker;
import com.blog.search.sync.SearchReconciler;
import com.blog.support.MeiliTestContainer;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.JsonNode;

/**
 * Reconciling PostgreSQL with the index by contentHash on a real Meilisearch: missing, stale and surplus documents
 * are fixed; old FAILED rows are released, rows that failed after the start are not; a source that changes during the
 * write sends the document back to the outbox; without configuration or without an index nothing is done. Drift is
 * created straight in the DB and index, not via the outbox.
 */
class SearchReconcileIT extends MeiliIntegrationTest {

    @Autowired
    private SearchReconciler reconciler;

    @Autowired
    private SearchProperties properties;

    @Autowired
    private SearchDocumentSource source;

    @Autowired
    private StaticSearchContent staticContent;

    @Autowired
    private SearchOutbox outbox;

    @Autowired
    private SearchOutboxRepository repository;

    @Autowired
    private SearchOutboxWorker worker;

    @Autowired
    private SearchMetrics metrics;

    @Autowired
    private MeiliHttpClient client;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private Clock clock;

    @BeforeEach
    void cleanOutbox() {
        assertThat(jdbcTemplate.queryForObject("SELECT current_database()", String.class))
                .isEqualTo("meili_search_it");
        jdbcTemplate.update("DELETE FROM search_outbox");
    }

    @Test
    void fixes_missing_stale_surplus_documents_releases_old_failed_rows_and_rerun_changes_nothing() throws Exception {
        String word = uniqueWord();
        Taxon category = createCategory("Reconcile " + word, null);
        UUID missing = publish("Missing " + word, "noi dung", null, category);
        UUID stale = publish("Old " + word, "noi dung", null, category);
        UUID hidden = publish("Hidden " + word, "noi dung", null, category);
        reindex();
        jdbcTemplate.update("DELETE FROM search_outbox");

        // Drift not via the outbox: delete by hand in the index, edit and unpublish straight in the DB, add a
        // document with no source.
        client.waitForTask(client.deleteDocuments(INDEX, List.of("post-" + missing)), Duration.ofSeconds(30));
        jdbcTemplate.update("UPDATE posts SET title = ? WHERE id = ?", "New " + word, stale);
        jdbcTemplate.update("UPDATE posts SET status = 'DRAFT' WHERE id = ?", hidden);
        String orphan = UUID.randomUUID().toString();
        client.waitForTask(
                client.addOrReplaceDocuments(
                        INDEX,
                        List.of(Map.of(
                                "id",
                                "post-" + orphan,
                                "type",
                                "post",
                                "sourceId",
                                orphan,
                                "contentHash",
                                "khong-khop"))),
                Duration.ofSeconds(30));
        // A FAILED row from before this run (even for a document that no longer has a source), and a row that failed
        // after the start.
        insertFailed("post", missing.toString(), Instant.now().minusSeconds(3600));
        insertFailed("post", UUID.randomUUID().toString(), Instant.now().minusSeconds(60));
        String later = UUID.randomUUID().toString();
        insertFailed("post", later, Instant.now().plusSeconds(3600));

        ReconcileReport report = reconciler.reconcile();

        assertThat(report.outcome()).isEqualTo(Outcome.COMPLETED);
        assertThat(report.failureCode()).isNull();
        assertThat(report.failed()).isZero();
        assertThat(report.scanned())
                .isEqualTo(source.countByType().values().stream()
                        .mapToLong(Long::longValue)
                        .sum());
        assertThat(report.upserted()).isGreaterThanOrEqualTo(2);
        assertThat(report.deleted()).isGreaterThanOrEqualTo(2);
        assertThat(report.resolvedFailedRows()).isEqualTo(2);
        assertThat(metrics.lastReconciliation()).isEqualTo(report);

        assertThat(indexedDocument(INDEX, "post-" + missing)).isNotNull();
        assertThat(indexedDocument(INDEX, "post-" + stale).path("title").asString())
                .isEqualTo("New " + word);
        assertThat(indexedDocument(INDEX, "post-" + stale).path("contentHash").asString())
                .isEqualTo(source.load(DocType.POST, List.of(stale)).getFirst().contentHash());
        assertThat(indexedDocument(INDEX, "post-" + hidden)).isNull();
        assertThat(indexedDocument(INDEX, "post-" + orphan)).isNull();
        assertThat(jdbcTemplate.queryForList(
                        "SELECT source_id FROM search_outbox WHERE state = 'FAILED'", String.class))
                .containsExactly(later);
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM search_outbox WHERE state = 'PENDING'", Long.class))
                .as("nothing to return to the outbox")
                .isZero();
        JsonNode found = search("q", word);
        assertThat(found.path("engine").asString()).isEqualTo("meilisearch");
        assertThat(items(found, "post"))
                .extracting(item -> joined(item.path("title")))
                .containsExactlyInAnyOrder("Missing " + word, "New " + word);

        // Idempotent: the next run has nothing left to fix.
        ReconcileReport again = reconciler.reconcile();
        assertThat(again.upserted() + again.deleted() + again.failed() + again.requeued())
                .isZero();
        assertThat(again.scanned()).isEqualTo(report.scanned());
    }

    @Test
    void source_changing_during_write_sends_document_back_to_outbox_and_worker_applies_latest() throws Exception {
        String word = uniqueWord();
        UUID post = publish("First " + word, "noi dung", null, createCategory("Changed while writing " + word, null));
        reindex();
        jdbcTemplate.update("DELETE FROM search_outbox");
        jdbcTemplate.update("UPDATE posts SET title = ? WHERE id = ?", "Middle " + word, post);

        // An edit finished right after this run read the DB (and before it re-reads): the version it just wrote is
        // stale.
        AtomicBoolean edited = new AtomicBoolean();
        SearchDocumentSource racing = new SearchDocumentSource(jdbcTemplate, staticContent) {
            @Override
            public List<SearchDocument> load(DocType type, Collection<UUID> ids) {
                if (ids.contains(post) && edited.compareAndSet(false, true)) {
                    jdbcTemplate.update("UPDATE posts SET title = ? WHERE id = ?", "Last " + word, post);
                }
                return super.load(type, ids);
            }
        };
        ReconcileReport report = reconciler(properties, racing).reconcile();

        assertThat(report.outcome()).isEqualTo(Outcome.COMPLETED);
        assertThat(report.requeued()).isGreaterThanOrEqualTo(1);
        assertThat(indexedDocument(INDEX, "post-" + post).path("title").asString())
                .isEqualTo("Middle " + word);
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM search_outbox WHERE doc_type = 'post' "
                                + "AND source_id = ? AND state = 'PENDING'",
                        Long.class,
                        post.toString()))
                .isEqualTo(1);
        assertThat(worker.runOnce().failed()).isZero();
        assertThat(indexedDocument(INDEX, "post-" + post).path("title").asString())
                .isEqualTo("Last " + word);
    }

    @Test
    void unconfigured_or_missing_index_fixes_nothing() throws Exception {
        ReconcileReport before = metrics.lastReconciliation();
        ReconcileReport unconfigured =
                reconciler(meiliProperties("", INDEX), source).reconcile();
        assertThat(unconfigured.outcome()).isEqualTo(Outcome.SKIPPED);
        assertThat(unconfigured.failureCode()).isEqualTo("NOT_CONFIGURED");
        assertThat(unconfigured.scanned()).isZero();
        assertThat(metrics.lastReconciliation())
                .as("a no-op run is not recorded")
                .isSameAs(before);

        String absent = "content_it_absent_" + uniqueWord();
        SearchProperties noIndex = meiliProperties(MeiliTestContainer.url(), absent);
        ReconcileReport skipped = reconciler(noIndex, source).reconcile();
        assertThat(skipped.outcome()).isEqualTo(Outcome.SKIPPED);
        assertThat(skipped.failureCode()).isEqualTo("INDEX_NOT_FOUND");
        assertThat(skipped.scanned()).isZero();
        assertThat(client.indexExists(absent)).isFalse();

        ReconcileReport down =
                reconciler(meiliProperties("http://127.0.0.1:1", INDEX), source).reconcile();
        assertThat(down.outcome()).isEqualTo(Outcome.ABORTED);
        assertThat(down.failureCode()).isEqualTo("CONNECTION_FAILED");
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /** A separate reconciler (other configuration or source), same DB and outbox; the metrics are the shared bean. */
    private SearchReconciler reconciler(SearchProperties config, SearchDocumentSource documents) {
        MeiliHttpClient engine = new MeiliHttpClient(config, objectMapper);
        SearchIndexer writer = new SearchIndexer(engine, new MeiliKeys(engine, config), documents);
        return new SearchReconciler(config, writer, documents, outbox, repository, metrics, transactionManager, clock);
    }

    private void insertFailed(String type, String sourceId, Instant failedAt) {
        jdbcTemplate.update(
                "INSERT INTO search_outbox (doc_type, source_id, state, attempts, next_attempt_at, "
                        + "last_error_code, created_at, updated_at) VALUES (?, ?, 'FAILED', 10, ?, 'INDEX_NOT_FOUND', ?, ?)",
                type,
                sourceId,
                Timestamp.from(failedAt),
                Timestamp.from(failedAt),
                Timestamp.from(failedAt));
    }
}
