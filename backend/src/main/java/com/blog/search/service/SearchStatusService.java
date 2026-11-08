package com.blog.search.service;

import com.blog.search.config.SearchProperties;
import com.blog.search.dto.SearchStatusResponse;
import com.blog.search.index.DocType;
import com.blog.search.index.SearchDocumentSource;
import com.blog.search.meili.MeiliException;
import com.blog.search.meili.MeiliHttpClient;
import com.blog.search.sync.SearchMaintenanceLock;
import com.blog.search.sync.SearchOutboxRepository;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

/**
 * {@code GET /api/v1/admin/search/status}: the engine, whether Meilisearch is alive, the index and its document count by
 * type next to the PostgreSQL count, the outbox, the latest reconcile pass, the counters. Read-only: creates no key,
 * writes nothing. Asks Meilisearch step by step, stopping at the first failure (its code goes into {@code error}); asks
 * nothing when it is not configured or {@code /health} fails.
 */
@Service
public class SearchStatusService {

    private static final Logger log = LoggerFactory.getLogger(SearchStatusService.class);

    static final String CLIENT_ERROR = "CLIENT_ERROR";

    private final SearchProperties properties;
    private final MeiliHttpClient client;
    private final SearchDocumentSource source;
    private final SearchOutboxRepository outboxRepository;
    private final SearchMetrics metrics;
    private final SearchMaintenanceLock lock;
    private final Clock clock;

    public SearchStatusService(
            SearchProperties properties,
            MeiliHttpClient client,
            SearchDocumentSource source,
            SearchOutboxRepository outboxRepository,
            SearchMetrics metrics,
            SearchMaintenanceLock lock,
            Clock clock) {
        this.properties = properties;
        this.client = client;
        this.source = source;
        this.outboxRepository = outboxRepository;
        this.metrics = metrics;
        this.lock = lock;
        this.clock = clock;
    }

    public SearchStatusResponse status() {
        SearchProperties.Meili meili = properties.meili();
        Probe probe = meili.configured() ? probe(meili.indexName()) : new Probe();
        SearchOutboxRepository.Stats outbox = outboxRepository.stats();
        Long oldestAge = outbox.oldestPendingCreatedAt() == null
                ? null
                : Math.max(
                        0,
                        Duration.between(outbox.oldestPendingCreatedAt(), clock.instant())
                                .toSeconds());
        SearchMetrics.Snapshot counters = metrics.snapshot();
        return new SearchStatusResponse(
                properties.engine(),
                !meili.url().isEmpty(),
                lock.held(),
                new SearchStatusResponse.Meilisearch(meili.configured(), probe.reachable, probe.version, probe.error),
                new SearchStatusResponse.Index(meili.indexName(), probe.exists, probe.documents, probe.byType),
                new SearchStatusResponse.Database(source.countByType()),
                new SearchStatusResponse.Outbox(outbox.pending(), outbox.processing(), outbox.failed(), oldestAge),
                metrics.lastReconciliation(),
                new SearchStatusResponse.Counters(
                        counters.degradedRequests(),
                        counters.lastDegradedAt(),
                        counters.lastFailure() == null
                                ? null
                                : counters.lastFailure().name(),
                        counters.staleHitsDropped(),
                        counters.deepPageFallbacks(),
                        counters.outboxSynced(),
                        counters.outboxFailed()));
    }

    /** What could be read from Meilisearch; null means not asked or unreadable. */
    private static final class Probe {
        private Boolean reachable;
        private String version;
        private Boolean exists;
        private Long documents;
        private Map<String, Long> byType;
        private String error;
    }

    private Probe probe(String index) {
        Probe probe = new Probe();
        try {
            probe.reachable = client.healthy();
            if (!probe.reachable) {
                return probe;
            }
            probe.version = client.version();
            probe.exists = client.indexExists(index);
            if (probe.exists) {
                probe.documents = client.numberOfDocuments(index);
                probe.byType = countsByType(index);
            }
        } catch (MeiliException e) {
            probe.error = e.code().name();
        } catch (RuntimeException e) {
            // Malformed URL or a programming error: the status page still answers. Only the class name, since the
            // message may echo the URL.
            probe.error = CLIENT_ERROR;
            log.warn("search status: meilisearch probe failed: {}", e.getClass().getName());
        }
        return probe;
    }

    /** The {@code facetDistribution} of {@code type} from an empty search with the search key; in DocType order. */
    private Map<String, Long> countsByType(String index) {
        JsonNode facets = client.multiSearch(
                        List.of(Map.of("indexUid", index, "q", "", "limit", 0, "facets", List.of("type"))))
                .get(0)
                .path("facetDistribution")
                .path("type");
        Map<String, Long> counts = new LinkedHashMap<>();
        for (DocType type : DocType.values()) {
            counts.put(type.value(), facets.path(type.value()).asLong(0));
        }
        // An unknown type (written into the index by hand) still shows, so the total matches numberOfDocuments.
        facets.properties()
                .forEach(entry ->
                        counts.putIfAbsent(entry.getKey(), entry.getValue().asLong(0)));
        return counts;
    }
}
