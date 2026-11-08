package com.blog.search.sync;

import com.blog.search.config.SearchProperties;
import com.blog.search.index.DocType;
import com.blog.search.index.SearchDocument;
import com.blog.search.index.SearchDocumentSource;
import com.blog.search.index.SearchDocuments;
import com.blog.search.index.SearchIndexer;
import com.blog.search.meili.MeiliException;
import com.blog.search.service.SearchMetrics;
import com.blog.search.service.StaticSearchContent;
import com.blog.search.sync.SearchOutboxRepository.Claimed;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.LongSupplier;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Search outbox worker: a short transaction claims a batch (SKIP LOCKED, lease); OUTSIDE a transaction it re-reads the
 * DB, writes or deletes documents, and stores the task_uid before waiting; a short transaction deletes the rows or
 * schedules a retry (30 seconds, doubling, capped at 30 minutes, FAILED at the 10th attempt). The write task of a failed
 * batch is resent document by document: only the rows of the rejected documents fail. At least once, eventually
 * consistent; the read side already hides content that is no longer public. FAILED rows are resolved by reconciliation
 * (SearchReconciler).
 */
@Component
public class SearchOutboxWorker {

    private static final Logger log = LoggerFactory.getLogger(SearchOutboxWorker.class);

    static final int BATCH = 50;
    /** Batches per run: a run does not hold the shared scheduler thread for too long. */
    static final int MAX_BATCHES = 10;
    /** Longer than anything a batch can wait: two submissions (10 seconds each) and two tasks ({@link #TASK_WAIT} each). */
    static final Duration LEASE = Duration.ofMinutes(5);

    static final Duration TASK_WAIT = Duration.ofSeconds(30);
    static final Duration FIRST_BACKOFF = Duration.ofSeconds(30);
    static final Duration MAX_BACKOFF = Duration.ofMinutes(30);
    /** About 2 hours 20 minutes from the first failure to FAILED: an engine outage shorter than that heals by itself. */
    static final int MAX_ATTEMPTS = 10;
    /** An error that is not from Meilisearch (a failed DB read, a programming error): only the code name, no message. */
    static final String INTERNAL_ERROR = "INTERNAL_ERROR";

    private final SearchOutboxRepository repository;
    private final SearchDocumentSource source;
    private final StaticSearchContent staticContent;
    private final SearchIndexer indexer;
    private final SearchMetrics metrics;
    private final TransactionTemplate transaction;
    private final Clock clock;
    private final boolean enabled;
    private final String index;

    public SearchOutboxWorker(
            SearchOutboxRepository repository,
            SearchDocumentSource source,
            StaticSearchContent staticContent,
            SearchIndexer indexer,
            SearchProperties properties,
            SearchMetrics metrics,
            PlatformTransactionManager transactionManager,
            Clock clock) {
        this.repository = repository;
        this.source = source;
        this.staticContent = staticContent;
        this.indexer = indexer;
        this.metrics = metrics;
        this.transaction = new TransactionTemplate(transactionManager);
        this.clock = clock;
        // Same condition as SearchOutbox: without a URL there are no rows, and the run does not touch the DB.
        this.enabled = !properties.meili().url().isEmpty();
        this.index = properties.meili().indexName();
    }

    /** Row counts of one run: synced, and failed (will be retried or already FAILED). */
    public record RunSummary(int synced, int failed) {}

    public RunSummary runOnce() {
        if (!enabled) {
            return new RunSummary(0, 0);
        }
        int synced = 0;
        int failed = 0;
        for (int batch = 0; batch < MAX_BATCHES; batch++) {
            Instant now = now();
            Instant lease = now.plus(LEASE);
            List<Claimed> rows = transaction.execute(status -> repository.claim(now, lease, BATCH));
            if (rows == null || rows.isEmpty()) {
                break;
            }
            Pass pass = new Pass(lease);
            pass.process(rows);
            synced += pass.synced;
            failed += pass.failed;
            if (pass.engineDown != null || rows.size() < BATCH) {
                break;
            }
        }
        metrics.outboxRun(synced, failed);
        if (synced + failed > 0) {
            log.info("search outbox worker: synced={} failed={}", synced, failed);
        }
        return new RunSummary(synced, failed);
    }

    /** Microseconds like timestamptz: the lease deadline is the matching key of the statements that end a pass. */
    private Instant now() {
        return clock.instant().truncatedTo(ChronoUnit.MICROS);
    }

    /** One claimed batch: its rows share one lease deadline. */
    private final class Pass {

        private final Instant lease;
        private int synced;
        private int failed;
        /** An engine-wide failure met in this batch: the remaining rows fail with it without further calls. */
        private MeiliException.Code engineDown;

        Pass(Instant lease) {
            this.lease = lease;
        }

        void process(List<Claimed> rows) {
            Map<Long, List<Claimed>> resumed = rows.stream()
                    .filter(row -> row.taskUid() != null)
                    .collect(Collectors.groupingBy(Claimed::taskUid, LinkedHashMap::new, Collectors.toList()));
            resumed.forEach((task, group) -> await(task, group, null));
            List<Claimed> fresh =
                    rows.stream().filter(row -> row.taskUid() == null).toList();
            if (!fresh.isEmpty()) {
                send(fresh);
            }
        }

        private void send(List<Claimed> rows) {
            List<SearchDocument> documents = new ArrayList<>();
            List<Claimed> upserts = new ArrayList<>();
            Set<String> deleteIds = new LinkedHashSet<>();
            List<Claimed> deletes = new ArrayList<>();
            Map<String, SearchDocument> visible = new LinkedHashMap<>();
            try {
                rows.stream()
                        .collect(Collectors.groupingBy(Claimed::type, LinkedHashMap::new, Collectors.toList()))
                        .forEach((type, group) ->
                                load(type, group).forEach(document -> visible.put(document.id(), document)));
                documents.addAll(visible.values());
                for (Claimed row : rows) {
                    if (visible.containsKey(row.documentId())) {
                        upserts.add(row);
                    } else {
                        deleteIds.add(row.documentId());
                        deletes.add(row);
                    }
                }
            } catch (RuntimeException e) {
                log.warn("search outbox rows not loaded: {}", e.getClass().getName());
                markFailed(rows, INTERNAL_ERROR, false);
                return;
            }
            try {
                if (!indexer.indexExists(index)) {
                    throw new MeiliException(MeiliException.Code.INDEX_NOT_FOUND);
                }
            } catch (MeiliException e) {
                markFailed(rows, e.code().name(), false);
                engineDown = e.code();
                return;
            }
            Long upsertTask = submit(upserts, () -> indexer.submitUpsert(index, documents));
            Long deleteTask = submit(deletes, () -> indexer.submitDelete(index, deleteIds));
            if (upsertTask != null) {
                await(upsertTask, upserts, visible);
            }
            if (deleteTask != null) {
                await(deleteTask, deletes, null);
            }
        }

        /** Submits, then records the task uid on the rows; null when there is nothing to submit or the submission failed (the rows already failed with it). */
        private Long submit(List<Claimed> rows, LongSupplier send) {
            if (rows.isEmpty()) {
                return null;
            }
            if (engineDown != null) {
                markFailed(rows, engineDown.name(), false);
                return null;
            }
            long task;
            try {
                task = send.getAsLong();
            } catch (MeiliException e) {
                markFailed(rows, e.code().name(), false);
                if (e.code().engineWide()) {
                    engineDown = e.code();
                }
                return null;
            }
            long sent = task;
            transaction.executeWithoutResult(status -> repository.recordTask(ids(rows), lease, sent, now()));
            return sent;
        }

        /**
         * @param retryEach documents of a batch written by id; when the batch task fails ({@code TASK_FAILED}) the documents
         *                  are resent one by one, so only the rows of the bad document fail. null for deletes and re-polled tasks
         */
        private void await(long task, List<Claimed> rows, Map<String, SearchDocument> retryEach) {
            if (engineDown != null) {
                markFailed(rows, engineDown.name(), true);
                return;
            }
            try {
                indexer.await(task, TASK_WAIT);
            } catch (MeiliException e) {
                if (e.code() == MeiliException.Code.TASK_FAILED && retryEach != null && rows.size() > 1) {
                    for (Claimed row : rows) {
                        SearchDocument document = retryEach.get(row.documentId());
                        Long single = submit(List.of(row), () -> indexer.submitUpsert(index, List.of(document)));
                        if (single != null) {
                            await(single, List.of(row), null);
                        }
                    }
                    return;
                }
                // The engine did not answer: the task may still finish, poll it again next time. A failed, canceled or
                // lost task: resubmit.
                boolean pollAgain = e.code().engineWide();
                markFailed(rows, e.code().name(), pollAgain);
                if (pollAgain) {
                    engineDown = e.code();
                }
                return;
            }
            transaction.executeWithoutResult(status -> repository.delete(ids(rows), lease));
            synced += rows.size();
        }

        private void markFailed(List<Claimed> rows, String code, boolean pollAgain) {
            Instant now = now();
            List<Long> ids = ids(rows);
            transaction.executeWithoutResult(status -> {
                if (pollAgain) {
                    repository.keepWaiting(ids, lease, code, now, FIRST_BACKOFF, MAX_BACKOFF, MAX_ATTEMPTS);
                }
                // After keepWaiting: only rows without a task or out of attempts that carry this lease are left.
                repository.fail(ids, lease, code, now, FIRST_BACKOFF, MAX_BACKOFF, MAX_ATTEMPTS);
            });
            failed += rows.size();
            log.warn("search outbox: {} rows not synced code={}", rows.size(), code);
        }
    }

    /** The still-public documents of these rows; a source missing from the result needs to be deleted. */
    private List<SearchDocument> load(DocType type, List<Claimed> rows) {
        if (type.fromDatabase()) {
            return source.load(
                    type,
                    rows.stream()
                            .map(row -> UUID.fromString(row.sourceId()))
                            .collect(Collectors.toCollection(LinkedHashSet::new)));
        }
        Set<String> slugs = rows.stream().map(Claimed::sourceId).collect(Collectors.toSet());
        return type == DocType.CASE_STUDY
                ? staticContent.caseStudies().stream()
                        .filter(study -> slugs.contains(study.slug()))
                        .map(SearchDocuments::caseStudy)
                        .toList()
                : staticContent.pages().stream()
                        .filter(page -> slugs.contains(page.slug()))
                        .map(SearchDocuments::page)
                        .toList();
    }

    private static List<Long> ids(List<Claimed> rows) {
        return rows.stream().map(Claimed::id).toList();
    }
}
