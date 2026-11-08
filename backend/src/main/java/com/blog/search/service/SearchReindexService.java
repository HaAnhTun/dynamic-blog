package com.blog.search.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.search.config.SearchProperties;
import com.blog.search.dto.ReindexReport;
import com.blog.search.index.SearchDocument;
import com.blog.search.index.SearchDocumentSource;
import com.blog.search.index.SearchIndexer;
import com.blog.search.meili.MeiliException;
import com.blog.search.meili.MeiliHttpClient;
import com.blog.search.sync.ReconcileReport;
import com.blog.search.sync.SearchMaintenanceLock;
import com.blog.search.sync.SearchOutboxRepository;
import com.blog.search.sync.SearchReconciler;
import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * {@code POST /api/v1/admin/search/reindex}: rebuilds the index from PostgreSQL without ever dropping the serving index
 * before its replacement is complete.
 *
 * Real run: records T0; deletes the old {@code <index>_build}; creates it with the settings; writes every public document
 * in batches, waiting for each task (a rejected batch is resent document by document); compares its document count with
 * the number written; swaps with the serving index (renames when there is none), waiting for the global task with the
 * indexing key; deletes the old index; reconciles right away to catch changes since T0 (the worker wrote them to the old
 * index, lost on the swap). Failure before the swap: the partial build is deleted, the serving index is untouched, 502.
 * Idempotent: running again gives the same index. One maintenance job at a time ({@link SearchMaintenanceLock}): the
 * second attempt gets 409.
 *
 * Dry run: only counts and reads, writes nothing, not even Meilisearch keys. Both count against the admin
 * {@code search-reindex} rate limit.
 */
@Service
public class SearchReindexService {

    private static final Logger log = LoggerFactory.getLogger(SearchReindexService.class);

    static final String BUILD_SUFFIX = "_build";

    /** Stage of a real run: the error message says where it stopped. */
    enum Stage {
        PREPARE,
        BUILD,
        COUNT_CHECK,
        SWAP
    }

    private final SearchProperties properties;
    private final MeiliHttpClient client;
    private final SearchIndexer indexer;
    private final SearchDocumentSource source;
    private final SearchReconciler reconciler;
    private final SearchOutboxRepository outboxRepository;
    private final SearchMaintenanceLock lock;
    private final RateLimiter rateLimiter;
    private final Clock clock;

    public SearchReindexService(
            SearchProperties properties,
            MeiliHttpClient client,
            SearchIndexer indexer,
            SearchDocumentSource source,
            SearchReconciler reconciler,
            SearchOutboxRepository outboxRepository,
            SearchMaintenanceLock lock,
            RateLimiter rateLimiter,
            Clock clock) {
        this.properties = properties;
        this.client = client;
        this.indexer = indexer;
        this.source = source;
        this.reconciler = reconciler;
        this.outboxRepository = outboxRepository;
        this.lock = lock;
        this.rateLimiter = rateLimiter;
        this.clock = clock;
    }

    /**
     * @throws ApiException 429 {@code RATE_LIMITED}; real run: 409 {@code SEARCH_NOT_CONFIGURED},
     *                      409 {@code SEARCH_REINDEX_RUNNING}, 502 {@code SEARCH_REINDEX_FAILED}
     */
    public ReindexReport reindex(UUID adminId, boolean dryRun) {
        rateLimiter.check(RateLimiter.SEARCH_REINDEX, adminId);
        if (dryRun) {
            return dryRun();
        }
        if (!properties.meili().configured()) {
            throw new ApiException(
                    ErrorCode.SEARCH_NOT_CONFIGURED,
                    HttpStatus.CONFLICT,
                    "Meilisearch is not configured: set MEILI_URL and MEILI_MASTER_KEY, then restart the backend");
        }
        if (!lock.tryAcquire()) {
            throw new ApiException(
                    ErrorCode.SEARCH_REINDEX_RUNNING,
                    HttpStatus.CONFLICT,
                    "A search reindex or reconciliation is already running; try again when it has finished");
        }
        try {
            return rebuild();
        } finally {
            lock.release();
        }
    }

    private ReindexReport dryRun() {
        Instant started = clock.instant();
        String index = properties.meili().indexName();
        Map<String, Long> byType = source.countByType();
        long expected = byType.values().stream().mapToLong(Long::longValue).sum();
        Long documents = null;
        String engineError = MeiliException.Code.NOT_CONFIGURED.name();
        if (properties.meili().configured()) {
            try {
                // Straight to the client, not through SearchIndexer: the indexer creates missing keys, and a dry run
                // writes nothing.
                if (client.indexExists(index)) {
                    documents = client.numberOfDocuments(index);
                    engineError = null;
                } else {
                    engineError = MeiliException.Code.INDEX_NOT_FOUND.name();
                }
            } catch (MeiliException e) {
                engineError = e.code().name();
            }
        }
        SearchOutboxRepository.Stats outbox = outboxRepository.stats();
        return new ReindexReport(
                true,
                index,
                started,
                clock.instant(),
                false,
                expected,
                0,
                expected,
                0,
                0,
                byType,
                documents,
                outbox.pending(),
                outbox.failed(),
                engineError,
                null);
    }

    /** Counts of the build pass; fields changed inside the lambda of forEachBatch. */
    private static final class Build {
        private long scanned;
        private long indexed;
        private long failed;
        private final Map<String, Long> byType = new LinkedHashMap<>();

        void add(List<SearchDocument> batch, List<SearchDocument> rejected) {
            scanned += batch.size();
            failed += rejected.size();
            for (SearchDocument document : batch) {
                if (!rejected.contains(document)) {
                    indexed++;
                    byType.merge(document.type(), 1L, Long::sum);
                }
            }
            if (!rejected.isEmpty()) {
                log.warn(
                        "search reindex: {} documents rejected by meilisearch ids={}",
                        rejected.size(),
                        rejected.stream().map(SearchDocument::id).toList());
            }
        }
    }

    private ReindexReport rebuild() {
        Instant started = clock.instant();
        String live = properties.meili().indexName();
        String build = live + BUILD_SUFFIX;
        Build counts = new Build();
        Stage stage = Stage.PREPARE;
        boolean swapped = false;
        boolean oldIndexAtBuild;
        try {
            indexer.provisionKeys();
            indexer.dropIndex(build);
            indexer.prepare(build);
            stage = Stage.BUILD;
            source.forEachBatch(
                    SearchIndexer.BATCH_SIZE, batch -> counts.add(batch, indexer.upsertIsolating(build, batch)));
            if (counts.failed > 0) {
                throw aborted(
                        stage,
                        counts.failed + " of " + counts.scanned
                                + " documents were rejected by Meilisearch (their ids are in the backend log)");
            }
            stage = Stage.COUNT_CHECK;
            long inIndex = indexer.numberOfDocuments(build);
            if (inIndex != counts.indexed) {
                throw aborted(
                        stage, "the new index holds " + inIndex + " documents but " + counts.indexed + " were written");
            }
            stage = Stage.SWAP;
            oldIndexAtBuild = indexer.swapIn(build, live);
            swapped = true;
        } catch (MeiliException e) {
            throw aborted(stage, "Meilisearch " + e.code().name());
        } finally {
            if (!swapped) {
                discard(build);
            }
        }
        if (oldIndexAtBuild) {
            discard(build);
        }
        ReconcileReport catchUp = reconciler.reconcile();
        Long documents = null;
        try {
            documents = indexer.numberOfDocuments(live);
        } catch (MeiliException e) {
            // The swap is done; this number is only for reporting, the status page can read it again.
        }
        SearchOutboxRepository.Stats outbox = outboxRepository.stats();
        log.info(
                "search reindex: index={} scanned={} indexed={} catchUp={} catchUpUpserted={} catchUpDeleted={}",
                live,
                counts.scanned,
                counts.indexed,
                catchUp.outcome(),
                catchUp.upserted(),
                catchUp.deleted());
        return new ReindexReport(
                false,
                live,
                started,
                clock.instant(),
                true,
                counts.scanned,
                counts.indexed + catchUp.upserted(),
                0,
                catchUp.deleted(),
                counts.failed + catchUp.failed(),
                counts.byType,
                documents,
                outbox.pending(),
                outbox.failed(),
                null,
                catchUp);
    }

    /** Deletes the partial build, or the old index after the swap; if that fails, the next reindex deletes it in its first step. */
    private void discard(String build) {
        try {
            indexer.dropIndex(build);
        } catch (RuntimeException e) {
            log.warn(
                    "search reindex: {} not deleted: {}",
                    build,
                    e instanceof MeiliException meili
                            ? meili.code().name()
                            : e.getClass().getName());
        }
    }

    /** The message has only the stage, the code and the counts: no key, no URL, no Meilisearch error body. */
    private static ApiException aborted(Stage stage, String reason) {
        String live = stage == Stage.SWAP
                ? "Swapping is atomic: the live index is either the old one or the complete new one."
                : "The live index was not changed.";
        return new ApiException(
                ErrorCode.SEARCH_REINDEX_FAILED,
                HttpStatus.BAD_GATEWAY,
                "Reindex stopped at " + stage + ": " + reason + ". " + live);
    }
}
