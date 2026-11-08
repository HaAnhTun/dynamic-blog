package com.blog.search.sync;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Schedule of SearchOutboxWorker: every {@code app.search.worker-delay} (default 10 seconds) after the previous run ends.
 * {@code app.search.worker-enabled=false} removes this bean entirely: every IT does that and then calls the worker directly.
 */
@Component
@ConditionalOnBooleanProperty(name = "app.search.worker-enabled", matchIfMissing = true)
public class SearchSchedule {

    private static final Logger log = LoggerFactory.getLogger(SearchSchedule.class);

    private final SearchOutboxWorker worker;

    public SearchSchedule(SearchOutboxWorker worker) {
        this.worker = worker;
    }

    @Scheduled(
            fixedDelayString = "${app.search.worker-delay:10s}",
            initialDelayString = "${app.search.worker-delay:10s}")
    public void run() {
        try {
            worker.runOnce();
        } catch (RuntimeException e) {
            // Only the error class: the message of an SQL error may echo a row. The rows keep their lease, the next run
            // claims them again.
            log.error("search outbox worker run failed: {}", e.getClass().getName());
        }
    }
}
