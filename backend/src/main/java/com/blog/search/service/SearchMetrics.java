package com.blog.search.service;

import com.blog.search.meili.MeiliException;
import com.blog.search.meili.Throttle;
import com.blog.search.sync.ReconcileReport;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * In-memory search counters, since startup: degraded answers (with the time and code of the latest), stale results
 * dropped on re-validation, deep pages served by Postgres, outbox rows synced or failed, the latest reconcile pass.
 * The admin status endpoint reads {@link #snapshot()}. No query is kept here.
 */
@Component
public class SearchMetrics {

    private static final Logger log = LoggerFactory.getLogger(SearchMetrics.class);

    private final Clock clock;
    private final AtomicLong degradedRequests = new AtomicLong();
    private final AtomicLong staleHitsDropped = new AtomicLong();
    private final AtomicLong deepPageFallbacks = new AtomicLong();
    private final AtomicLong outboxSynced = new AtomicLong();
    private final AtomicLong outboxFailed = new AtomicLong();
    private final AtomicReference<Instant> lastDegradedAt = new AtomicReference<>();
    private final AtomicReference<MeiliException.Code> lastFailure = new AtomicReference<>();
    private final AtomicReference<ReconcileReport> lastReconciliation = new AtomicReference<>();
    private final Throttle degradedLog = new Throttle(Duration.ofMinutes(1));

    public SearchMetrics(Clock clock) {
        this.clock = clock;
    }

    /**
     * @param lastDegradedAt null when never
     * @param lastFailure    Meilisearch error code of the latest degraded answer, null when never
     * @param outboxSynced   outbox rows the worker finished syncing
     * @param outboxFailed   times an outbox row failed (retry later, or FAILED)
     */
    public record Snapshot(
            long degradedRequests,
            Instant lastDegradedAt,
            MeiliException.Code lastFailure,
            long staleHitsDropped,
            long deepPageFallbacks,
            long outboxSynced,
            long outboxFailed) {}

    public Snapshot snapshot() {
        return new Snapshot(
                degradedRequests.get(),
                lastDegradedAt.get(),
                lastFailure.get(),
                staleHitsDropped.get(),
                deepPageFallbacks.get(),
                outboxSynced.get(),
                outboxFailed.get());
    }

    /** The latest reconcile pass, including a SKIPPED or ABORTED one; null when none since startup. */
    public ReconcileReport lastReconciliation() {
        return lastReconciliation.get();
    }

    public void reconciled(ReconcileReport report) {
        lastReconciliation.set(report);
    }

    /** One run of the outbox worker. */
    public void outboxRun(int synced, int failed) {
        outboxSynced.addAndGet(synced);
        outboxFailed.addAndGet(failed);
    }

    /** A search returned the Postgres result because Meilisearch failed. Logs at most once a minute: the error code, no query. */
    void degraded(MeiliException failure) {
        degradedRequests.incrementAndGet();
        lastDegradedAt.set(clock.instant());
        lastFailure.set(failure.code());
        if (degradedLog.tryAcquire()) {
            log.warn("search degraded to postgres code={} degradedRequests={}", failure.code(), degradedRequests.get());
        }
    }

    void staleHitsDropped(int count) {
        if (count > 0) {
            staleHitsDropped.addAndGet(count);
        }
    }

    void deepPageFallback() {
        deepPageFallbacks.incrementAndGet();
    }
}
