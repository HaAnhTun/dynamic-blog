package com.blog.search.dto;

import com.blog.search.config.SearchProperties.Engine;
import com.blog.search.sync.ReconcileReport;
import java.time.Instant;
import java.util.Map;

/**
 * Response of {@code GET /api/v1/admin/search/status}. Only counts, flags, safe error codes and the index name: no key,
 * no URL, no query. The counters and the last reconcile pass live in memory, counted since startup.
 *
 * @param engine             engine that answers {@code GET /api/v1/search} ({@code SEARCH_ENGINE})
 * @param indexing           {@code MEILI_URL} has a value: every change writes the outbox and the worker syncs the index
 * @param maintenanceRunning a reindex or a reconcile pass is running
 * @param database           PostgreSQL documents by type, with the same visibility rules as the index, to compare with {@code index.byType}
 * @param lastReconciliation null when no pass has run since startup
 */
public record SearchStatusResponse(
        Engine engine,
        boolean indexing,
        boolean maintenanceRunning,
        Meilisearch meilisearch,
        Index index,
        Database database,
        Outbox outbox,
        ReconcileReport lastReconciliation,
        Counters counters) {

    /**
     * @param configured both {@code MEILI_URL} and {@code MEILI_MASTER_KEY} have values
     * @param reachable  {@code GET /health} returns {@code available}; null when not configured
     * @param version    engine version ({@code GET /version}); null when unreadable
     * @param error      safe code of the first failed read ({@code INVALID_API_KEY}, {@code TIMEOUT}...), null when none
     */
    public record Meilisearch(boolean configured, Boolean reachable, String version, String error) {}

    /**
     * @param name      {@code MEILI_INDEX_NAME}
     * @param exists    null when it could not be asked
     * @param documents {@code numberOfDocuments}; null when there is no index or it is unreadable
     * @param byType    {@code facetDistribution} of the {@code type} field, by type
     */
    public record Index(String name, Boolean exists, Long documents, Map<String, Long> byType) {}

    public record Database(Map<String, Long> byType) {}

    /**
     * @param oldestPendingAgeSeconds seconds since the first write of the oldest PENDING row; null when no row is waiting
     */
    public record Outbox(long pending, long processing, long failed, Long oldestPendingAgeSeconds) {}

    /**
     * @param lastDegradedCode Meilisearch error code of the most recent degraded request
     * @param staleHitsDropped Meilisearch results dropped because PostgreSQL no longer allows them to show (fail closed)
     * @param deepPageFallbacks post pages beyond the Meilisearch ceiling, served by PostgreSQL (a deliberate hybrid)
     */
    public record Counters(
            long degradedRequests,
            Instant lastDegradedAt,
            String lastDegradedCode,
            long staleHitsDropped,
            long deepPageFallbacks,
            long outboxSynced,
            long outboxFailed) {}
}
