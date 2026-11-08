package com.blog.search.sync;

import com.blog.search.config.SearchProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Reconcile schedule: {@code app.search.reconcile-cron}, by default minute 23 of every hour; {@code -} turns it off (every
 * IT does that and then calls SearchReconciler directly). Does nothing when Meilisearch is not configured; skips the pass
 * while a reindex is running.
 */
@Component
public class SearchReconcileSchedule {

    private static final Logger log = LoggerFactory.getLogger(SearchReconcileSchedule.class);

    private final SearchReconciler reconciler;
    private final SearchMaintenanceLock lock;
    private final SearchProperties properties;

    public SearchReconcileSchedule(
            SearchReconciler reconciler, SearchMaintenanceLock lock, SearchProperties properties) {
        this.reconciler = reconciler;
        this.lock = lock;
        this.properties = properties;
    }

    @Scheduled(cron = "${app.search.reconcile-cron:0 23 * * * *}")
    public void run() {
        if (!properties.meili().configured()) {
            return;
        }
        if (!lock.tryAcquire()) {
            log.info("search reconciliation skipped: a reindex or reconciliation is running");
            return;
        }
        try {
            reconciler.reconcile();
        } catch (RuntimeException e) {
            log.error("search reconciliation run failed: {}", e.getClass().getName());
        } finally {
            lock.release();
        }
    }
}
