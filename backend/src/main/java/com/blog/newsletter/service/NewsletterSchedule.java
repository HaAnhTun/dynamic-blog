package com.blog.newsletter.service;

import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * The schedule of NewsletterWorker: every {@code app.newsletter.worker-delay} (default 30 seconds) after the previous
 * run finishes. {@code app.newsletter.worker-enabled=false} removes this bean entirely: every IT does that, then calls the worker directly.
 */
@Component
@ConditionalOnBooleanProperty(name = "app.newsletter.worker-enabled", matchIfMissing = true)
@RequiredArgsConstructor
public class NewsletterSchedule {

    private static final Logger log = LoggerFactory.getLogger(NewsletterSchedule.class);

    private final NewsletterWorker worker;

    @Scheduled(
            fixedDelayString = "${app.newsletter.worker-delay:30s}",
            initialDelayString = "${app.newsletter.worker-delay:30s}")
    public void run() {
        try {
            worker.runOnce();
        } catch (RuntimeException e) {
            // Only the error type, not the message: an SQL error echoes the whole faulty row, address included. The
            // next run retries.
            log.error("newsletter worker run failed: {}", e.getClass().getName());
        }
    }
}
