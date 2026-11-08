package com.blog.search.sync;

import com.blog.search.config.SearchProperties;
import com.blog.search.index.DocType;
import com.blog.search.index.SearchDocument;
import com.blog.search.index.SearchDocumentSource;
import com.blog.search.index.SearchIndexer;
import com.blog.search.meili.MeiliException;
import com.blog.search.meili.MeiliHttpClient;
import com.blog.search.service.SearchMetrics;
import com.blog.search.sync.ReconcileReport.Outcome;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;

/**
 * Reconciles the serving index with PostgreSQL by {@code contentHash}, the safety net of the outbox: changes that bypass
 * the outbox (static content at deploy, manual edits in the DB), writes lost when a reindex swaps the index, FAILED rows.
 *
 * One pass: read the id, type and hash of every document in the index page by page (only four short fields, never a post
 * body); walk the public content in batches as when building the index; rewrite documents that are missing or have a
 * different hash, delete surplus documents. After each write, re-read the DB for exactly those documents: a source that
 * changed during the write (the worker may have written a newer version before this pass's version) is handed back to the
 * outbox, so this pass never leaves a stale version behind. No transaction surrounds the Meilisearch calls; the caller
 * holds {@link SearchMaintenanceLock}.
 */
@Component
public class SearchReconciler {

    private static final Logger log = LoggerFactory.getLogger(SearchReconciler.class);

    /** Documents per page when reading the index: four short fields, about 200 bytes per document. */
    static final int FETCH_PAGE = 1000;

    static final List<String> FIELDS = List.of("id", "type", "sourceId", "contentHash");
    static final String INTERNAL_ERROR = "INTERNAL_ERROR";

    private final SearchProperties properties;
    private final SearchIndexer indexer;
    private final SearchDocumentSource source;
    private final SearchOutbox outbox;
    private final SearchOutboxRepository repository;
    private final SearchMetrics metrics;
    private final TransactionTemplate transaction;
    private final Clock clock;

    public SearchReconciler(
            SearchProperties properties,
            SearchIndexer indexer,
            SearchDocumentSource source,
            SearchOutbox outbox,
            SearchOutboxRepository repository,
            SearchMetrics metrics,
            PlatformTransactionManager transactionManager,
            Clock clock) {
        this.properties = properties;
        this.indexer = indexer;
        this.source = source;
        this.outbox = outbox;
        this.repository = repository;
        this.metrics = metrics;
        this.transaction = new TransactionTemplate(transactionManager);
        this.clock = clock;
    }

    /**
     * One pass over the index {@code MEILI_INDEX_NAME}. Meilisearch not configured: calls nothing, writes nothing. No such
     * index: SKIPPED (only reindex creates the serving index). Engine failure mid-pass: ABORTED with a code, what was fixed stays correct.
     */
    public ReconcileReport reconcile() {
        Instant started = clock.instant();
        if (!properties.meili().configured()) {
            return new ReconcileReport(
                    started, started, Outcome.SKIPPED, MeiliException.Code.NOT_CONFIGURED.name(), 0, 0, 0, 0, 0, 0);
        }
        ReconcileReport report = new Pass(started, properties.meili().indexName()).run();
        metrics.reconciled(report);
        log.info(
                "search reconciliation: outcome={} code={} scanned={} upserted={} deleted={} failed={} requeued={} "
                        + "resolvedFailedRows={}",
                report.outcome(),
                report.failureCode(),
                report.scanned(),
                report.upserted(),
                report.deleted(),
                report.failed(),
                report.requeued(),
                report.resolvedFailedRows());
        return report;
    }

    /** A document of the index as this pass read it at the start. */
    private record Indexed(String type, String sourceId, String contentHash) {}

    private final class Pass {

        private final Instant started;
        private final String index;
        private long scanned;
        private long upserted;
        private long deleted;
        private long failed;
        private long requeued;

        Pass(Instant started, String index) {
            this.started = started;
            this.index = index;
        }

        ReconcileReport run() {
            try {
                if (!indexer.indexExists(index)) {
                    return report(Outcome.SKIPPED, MeiliException.Code.INDEX_NOT_FOUND.name(), 0);
                }
                Map<String, Indexed> indexed = snapshot();
                source.forEachBatch(SearchIndexer.BATCH_SIZE, batch -> compare(batch, indexed));
                removeExtras(indexed);
            } catch (MeiliException e) {
                return report(Outcome.ABORTED, e.code().name(), 0);
            } catch (RuntimeException e) {
                // Only the class name: the message of an SQL error may echo a row.
                log.warn("search reconciliation failed: {}", e.getClass().getName());
                return report(Outcome.ABORTED, INTERNAL_ERROR, 0);
            }
            return report(Outcome.COMPLETED, null, failed == 0 ? repository.resolveFailed(started) : 0);
        }

        private ReconcileReport report(Outcome outcome, String code, long resolved) {
            return new ReconcileReport(
                    started, clock.instant(), outcome, code, scanned, upserted, deleted, failed, requeued, resolved);
        }

        /** id → type, sourceId, hash of every document in the index, page by page. */
        private Map<String, Indexed> snapshot() {
            Map<String, Indexed> indexed = new HashMap<>();
            long offset = 0;
            while (true) {
                MeiliHttpClient.DocumentPage page = indexer.fetchDocuments(index, offset, FETCH_PAGE, FIELDS);
                for (JsonNode document : page.results()) {
                    JsonNode id = document.path("id");
                    if (id.isString()) {
                        indexed.put(
                                id.asString(),
                                new Indexed(
                                        text(document, "type"),
                                        text(document, "sourceId"),
                                        text(document, "contentHash")));
                    }
                }
                offset += page.results().size();
                if (page.results().size() < FETCH_PAGE || offset >= page.total()) {
                    return indexed;
                }
            }
        }

        /** A batch of public content: writes what is missing or has a different hash; what was seen leaves {@code indexed}, the rest is surplus. */
        private void compare(List<SearchDocument> batch, Map<String, Indexed> indexed) {
            List<SearchDocument> changed = new ArrayList<>();
            for (SearchDocument document : batch) {
                Indexed current = indexed.remove(document.id());
                if (current == null || !document.contentHash().equals(current.contentHash())) {
                    changed.add(document);
                }
            }
            scanned += batch.size();
            if (changed.isEmpty()) {
                return;
            }
            List<SearchDocument> rejected = indexer.upsertIsolating(index, changed);
            if (!rejected.isEmpty()) {
                failed += rejected.size();
                log.warn(
                        "search reconciliation: {} documents rejected by meilisearch ids={}",
                        rejected.size(),
                        rejected.stream().map(SearchDocument::id).toList());
            }
            List<SearchDocument> written = changed.stream()
                    .filter(document -> !rejected.contains(document))
                    .toList();
            upserted += written.size();
            requeueChanged(written);
        }

        private void removeExtras(Map<String, Indexed> extras) {
            List<Map.Entry<String, Indexed>> all = new ArrayList<>(extras.entrySet());
            for (int from = 0; from < all.size(); from += SearchIndexer.BATCH_SIZE) {
                List<Map.Entry<String, Indexed>> chunk =
                        all.subList(from, Math.min(from + SearchIndexer.BATCH_SIZE, all.size()));
                List<String> ids = chunk.stream().map(Map.Entry::getKey).toList();
                try {
                    indexer.delete(index, ids);
                } catch (MeiliException e) {
                    if (e.code() != MeiliException.Code.TASK_FAILED) {
                        throw e;
                    }
                    failed += ids.size();
                    log.warn("search reconciliation: delete of {} documents failed ids={}", ids.size(), ids);
                    continue;
                }
                deleted += ids.size();
                requeueVisible(chunk.stream().map(Map.Entry::getValue).toList());
            }
        }

        /** Re-reads the DB for documents just written: if the DB version differs (or is now hidden) the outbox rewrites it from the DB. */
        private void requeueChanged(List<SearchDocument> written) {
            Map<DocType, Set<UUID>> stale = new EnumMap<>(DocType.class);
            written.stream()
                    .filter(document -> fromDatabase(document.type()))
                    .collect(Collectors.groupingBy(
                            document -> DocType.of(document.type()).orElseThrow()))
                    .forEach((type, documents) -> {
                        Map<String, String> fresh = source
                                .load(
                                        type,
                                        documents.stream()
                                                .map(document -> UUID.fromString(document.sourceId()))
                                                .collect(Collectors.toCollection(LinkedHashSet::new)))
                                .stream()
                                .collect(Collectors.toMap(SearchDocument::id, SearchDocument::contentHash));
                        for (SearchDocument document : documents) {
                            if (!document.contentHash().equals(fresh.get(document.id()))) {
                                stale.computeIfAbsent(type, key -> new LinkedHashSet<>())
                                        .add(UUID.fromString(document.sourceId()));
                            }
                        }
                    });
            requeue(stale);
        }

        /** Re-reads the DB for documents just deleted: if the source became public again meanwhile, the outbox rewrites it. */
        private void requeueVisible(List<Indexed> removed) {
            Map<DocType, Set<UUID>> candidates = new EnumMap<>(DocType.class);
            for (Indexed document : removed) {
                DocType type = DocType.of(document.type())
                        .filter(DocType::fromDatabase)
                        .orElse(null);
                UUID id = uuid(document.sourceId());
                if (type != null && id != null) {
                    candidates
                            .computeIfAbsent(type, key -> new LinkedHashSet<>())
                            .add(id);
                }
            }
            Map<DocType, Set<UUID>> visible = new EnumMap<>(DocType.class);
            candidates.forEach((type, ids) -> source.load(type, ids)
                    .forEach(document -> visible.computeIfAbsent(type, key -> new LinkedHashSet<>())
                            .add(UUID.fromString(document.sourceId()))));
            requeue(visible);
        }

        private void requeue(Map<DocType, Set<UUID>> documents) {
            if (documents.isEmpty()) {
                return;
            }
            transaction.executeWithoutResult(status -> documents.forEach(outbox::enqueue));
            requeued += documents.values().stream().mapToInt(Set::size).sum();
        }
    }

    private static boolean fromDatabase(String type) {
        return DocType.of(type).map(DocType::fromDatabase).orElse(false);
    }

    private static UUID uuid(String value) {
        try {
            return value == null ? null : UUID.fromString(value);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static String text(JsonNode document, String field) {
        JsonNode value = document.path(field);
        return value.isString() ? value.asString() : null;
    }
}
