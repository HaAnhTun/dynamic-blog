package com.blog.search.sync;

import java.time.Instant;

/**
 * Result of one pass that reconciles PostgreSQL with the index; also the "latest reconcile pass" of the status page.
 *
 * @param outcome            {@code COMPLETED}; {@code SKIPPED} when the index does not exist; {@code ABORTED} when the engine failed mid-pass
 * @param failureCode        safe code when not COMPLETED ({@code INDEX_NOT_FOUND}, {@code CONNECTION_FAILED}...), null when
 *                           COMPLETED
 * @param scanned            documents read from PostgreSQL and static content, compared with the index
 * @param upserted           documents missing or with a different {@code contentHash}, written again
 * @param deleted            surplus documents (source gone or no longer public), deleted
 * @param failed             documents Meilisearch rejected, including when sent one by one (ids in the log)
 * @param requeued           documents whose source changed while this pass was writing, handed back to the outbox
 * @param resolvedFailedRows FAILED outbox rows resolved: only when the pass is COMPLETED and {@code failed} is 0
 */
public record ReconcileReport(
        Instant startedAt,
        Instant finishedAt,
        Outcome outcome,
        String failureCode,
        long scanned,
        long upserted,
        long deleted,
        long failed,
        long requeued,
        long resolvedFailedRows) {

    public enum Outcome {
        COMPLETED,
        SKIPPED,
        ABORTED
    }
}
