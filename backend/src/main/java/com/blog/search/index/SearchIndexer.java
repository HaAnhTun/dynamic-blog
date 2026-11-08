package com.blog.search.index;

import com.blog.search.meili.MeiliException;
import com.blog.search.meili.MeiliHttpClient;
import com.blog.search.meili.MeiliKeys;
import com.blog.search.meili.MeiliSettings;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Supplier;
import org.springframework.stereotype.Service;

/**
 * Writes to the Meilisearch index: add or replace documents, delete by id, build a whole index from the DB. Every write
 * waits for its task to finish (success, or throws {@link MeiliException} with a code), except {@code submit*}: the
 * outbox worker stores the task uid in the DB and only then calls {@link #await} on it.
 *
 * Never call from inside a transaction: a write waits on Meilisearch for up to minutes, and calling Meilisearch while
 * holding a transaction is forbidden. {@link SearchDocumentSource} reads the DB without needing a transaction.
 */
@Service
public class SearchIndexer {

    /** Documents per write: bodies can be long, keep the request far smaller than the 100 MB ceiling of Meilisearch. */
    public static final int BATCH_SIZE = 200;
    /** Wait for one task: building an index on a small machine with limited indexing memory can be slow. */
    static final Duration TASK_WAIT = Duration.ofMinutes(2);

    private final MeiliHttpClient client;
    private final MeiliKeys keys;
    private final SearchDocumentSource source;

    public SearchIndexer(MeiliHttpClient client, MeiliKeys keys, SearchDocumentSource source) {
        this.client = client;
        this.keys = keys;
        this.source = source;
    }

    /**
     * Number of documents written, by type.
     *
     * @param byType {@code type} → number of documents
     */
    public record BuildReport(int documents, Map<String, Integer> byType) {}

    /** Add or fully replace (same id), then wait for the task. */
    public void upsert(String indexUid, List<SearchDocument> documents) {
        if (documents.isEmpty()) {
            return;
        }
        await(submitUpsert(indexUid, documents), TASK_WAIT);
    }

    /** Delete by document id ({@code post-<uuid>}, ...); an id that does not exist is fine. */
    public void delete(String indexUid, Collection<String> documentIds) {
        if (documentIds.isEmpty()) {
            return;
        }
        await(submitDelete(indexUid, documentIds), TASK_WAIT);
    }

    /** Submits a batch of upserts without waiting: the outbox worker stores the task uid before waiting. @return the task uid */
    public long submitUpsert(String indexUid, List<SearchDocument> documents) {
        if (documents.isEmpty()) {
            throw new IllegalArgumentException("No documents to write");
        }
        for (SearchDocument document : documents) {
            if (!SearchDocuments.ID.matcher(document.id()).matches()) {
                throw new IllegalArgumentException("Search document id is not valid");
            }
        }
        return withKeys(() -> client.addOrReplaceDocuments(indexUid, documents));
    }

    /** Submits a batch of deletes by id without waiting. @return the task uid */
    public long submitDelete(String indexUid, Collection<String> documentIds) {
        if (documentIds.isEmpty()) {
            throw new IllegalArgumentException("No documents to delete");
        }
        return withKeys(() -> client.deleteDocuments(indexUid, documentIds));
    }

    /** Waits for a submitted task to finish; throws {@link MeiliException} with a code if it fails. */
    public void await(long taskUid, Duration timeout) {
        withKeys(() -> client.waitForTask(taskUid, timeout));
    }

    /**
     * Whether the index exists. The worker asks before writing: Meilisearch creates a missing index on its own when it
     * receives documents, but without settings, and only reindex may create the serving index.
     */
    public boolean indexExists(String indexUid) {
        return withKeys(() -> client.indexExists(indexUid));
    }

    /**
     * Like {@link #upsert}, but when the task of the whole batch fails ({@code TASK_FAILED}: Meilisearch rejecting one
     * document rejects the whole batch) the documents are sent again one at a time, so only the bad document stays out of
     * the index.
     *
     * @return documents still rejected when sent alone; empty when the whole batch got in
     * @throws MeiliException any other error (engine not answering, task canceled or wait timed out): the caller stops
     */
    public List<SearchDocument> upsertIsolating(String indexUid, List<SearchDocument> documents) {
        try {
            upsert(indexUid, documents);
            return List.of();
        } catch (MeiliException e) {
            if (e.code() != MeiliException.Code.TASK_FAILED) {
                throw e;
            }
            if (documents.size() == 1) {
                return List.copyOf(documents);
            }
        }
        List<SearchDocument> rejected = new ArrayList<>();
        for (SearchDocument document : documents) {
            try {
                upsert(indexUid, List.of(document));
            } catch (MeiliException e) {
                if (e.code() != MeiliException.Code.TASK_FAILED) {
                    throw e;
                }
                rejected.add(document);
            }
        }
        return rejected;
    }

    /** One page of documents of the index, only the requested fields (reconciliation). */
    public MeiliHttpClient.DocumentPage fetchDocuments(String indexUid, long offset, int limit, List<String> fields) {
        return withKeys(() -> client.fetchDocuments(indexUid, offset, limit, fields));
    }

    public long numberOfDocuments(String indexUid) {
        return withKeys(() -> client.numberOfDocuments(indexUid));
    }

    /** Creates the keys (first time) or re-checks them, and throws when that fails: reindex does not run with broken keys. */
    public void provisionKeys() {
        keys.provision();
    }

    /** Deletes the index if it exists, then waits. @return false when the index does not exist */
    public boolean dropIndex(String indexUid) {
        return withKeys(() -> {
            if (!client.indexExists(indexUid)) {
                return false;
            }
            client.waitForTask(client.deleteIndex(indexUid), TASK_WAIT);
            return true;
        });
    }

    /**
     * Puts {@code build} into service under the name {@code live}: swap (atomically) when {@code live} exists, rename when
     * it does not; waits for the task. After a swap, {@code build} holds the old index.
     *
     * @return true when swapped (the old index is at {@code build}), false when renamed ({@code build} no longer exists)
     */
    public boolean swapIn(String build, String live) {
        return withKeys(() -> {
            if (client.indexExists(live)) {
                client.waitForTask(client.swapIndexes(live, build), TASK_WAIT);
                return true;
            }
            client.waitForTask(client.renameIndex(build, live), TASK_WAIT);
            return false;
        });
    }

    /** A key was rejected (deleted by hand, engine rebuilt): the next call recreates it, like the search side. */
    private <T> T withKeys(Supplier<T> call) {
        keys.ensureProvisioned();
        try {
            return call.get();
        } catch (MeiliException e) {
            if (e.code() == MeiliException.Code.INVALID_API_KEY) {
                keys.invalidate();
            }
            throw e;
        }
    }

    /** The index exists with primary key {@code id} and exactly {@link MeiliSettings#SETTINGS}, before the first batch of documents. */
    public void prepare(String indexUid) {
        keys.ensureProvisioned();
        if (!client.indexExists(indexUid)) {
            client.waitForTask(client.createIndex(indexUid), TASK_WAIT);
        }
        client.waitForTask(client.updateSettings(indexUid, MeiliSettings.SETTINGS), TASK_WAIT);
    }

    /**
     * Rebuilds {@code indexUid} from scratch: delete if present, create, apply settings, then write every public document
     * in batches. That index would be missing or incomplete during the build, so never build straight into the serving
     * index: reindex builds into a side index and then swaps.
     */
    public BuildReport build(String indexUid) {
        keys.provision();
        if (client.indexExists(indexUid)) {
            client.waitForTask(client.deleteIndex(indexUid), TASK_WAIT);
        }
        prepare(indexUid);
        Map<String, Integer> byType = new TreeMap<>();
        source.forEachBatch(BATCH_SIZE, batch -> {
            upsert(indexUid, batch);
            batch.forEach(document -> byType.merge(document.type(), 1, Integer::sum));
        });
        return new BuildReport(
                byType.values().stream().mapToInt(Integer::intValue).sum(), Map.copyOf(byType));
    }
}
