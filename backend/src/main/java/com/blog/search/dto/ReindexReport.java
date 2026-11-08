package com.blog.search.dto;

import com.blog.search.sync.ReconcileReport;
import java.time.Instant;
import java.util.Map;

/**
 * Response of {@code POST /api/v1/admin/search/reindex}. Contains no key, URL or query.
 *
 * @param index           name of the serving index ({@code MEILI_INDEX_NAME})
 * @param startedAt       T0: the start time, before the DB is read
 * @param swapped         the new index is now serving (swapped, or renamed when there was no index); false on a dry run
 * @param scanned         documents read from PostgreSQL and static content (dry run: counted)
 * @param indexed         documents written to the new index, plus documents the reconcile pass right after rewrote
 * @param skipped         documents read but deliberately not written: all of them on a dry run, 0 on a real run
 * @param deleted         documents the reconcile pass after the swap deleted (source hidden or gone during the build)
 * @param failed          documents Meilisearch rejected (ids in the log), from the build and the reconcile pass
 * @param documentsByType per type, the documents the new index would have (dry run) or has (real run)
 * @param indexDocuments  document count of the serving index: before (dry run), after (real run); null when unreadable
 * @param outboxPending   pending outbox rows, read when answering
 * @param outboxFailed    FAILED outbox rows, read when answering
 * @param engineError     dry run: why {@code indexDocuments} is null ({@code NOT_CONFIGURED}, {@code INDEX_NOT_FOUND},
 *                        {@code CONNECTION_FAILED}...); null when readable, and on a real run
 * @param catchUp         real run: the reconcile pass right after the swap, catching changes since T0; null on a dry run
 */
public record ReindexReport(
        boolean dryRun,
        String index,
        Instant startedAt,
        Instant finishedAt,
        boolean swapped,
        long scanned,
        long indexed,
        long skipped,
        long deleted,
        long failed,
        Map<String, Long> documentsByType,
        Long indexDocuments,
        long outboxPending,
        long outboxFailed,
        String engineError,
        ReconcileReport catchUp) {}
