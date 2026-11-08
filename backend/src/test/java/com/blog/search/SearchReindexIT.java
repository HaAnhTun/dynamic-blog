package com.blog.search;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.ClientAddress;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.common.security.SeedAdmin;
import com.blog.post.dto.PostUpdateRequest;
import com.blog.post.service.PostService;
import com.blog.search.config.SearchProperties;
import com.blog.search.config.SearchProperties.Engine;
import com.blog.search.dto.ReindexReport;
import com.blog.search.dto.SearchResponse;
import com.blog.search.dto.SearchStatusResponse;
import com.blog.search.index.SearchDocument;
import com.blog.search.index.SearchDocumentSource;
import com.blog.search.meili.MeiliHttpClient;
import com.blog.search.meili.MeiliKeys;
import com.blog.search.service.MeiliSearchProvider;
import com.blog.search.service.PostgresSearchProvider;
import com.blog.search.service.SearchMetrics;
import com.blog.search.service.SearchReindexService;
import com.blog.search.service.SearchService;
import com.blog.search.service.SearchStatusService;
import com.blog.search.service.StaticSearchContent;
import com.blog.search.sync.ReconcileReport;
import com.blog.search.sync.SearchMaintenanceLock;
import com.blog.search.sync.SearchOutboxRepository;
import com.blog.search.sync.SearchOutboxWorker;
import com.blog.search.sync.SearchReconcileSchedule;
import com.blog.search.sync.SearchReconciler;
import com.blog.support.MeiliTestContainer;
import java.time.Clock;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;

/**
 * Reindex, status and rollback of search on a real Meilisearch. Reindex builds {@code <index>_build} then swaps; a
 * failed build never touches the serving index; changes during the build (the worker writing to the old index) are
 * present afterwards thanks to the reconcile pass right after. A real reindex calls the service directly with a
 * random admin id (rate limit is per admin); the HTTP path is covered in the dry run, 409 and status. No test sleeps:
 * where "running" is needed a latch is used.
 */
class SearchReindexIT extends MeiliIntegrationTest {

    private static final String BUILD = INDEX + "_build";
    private static final String REINDEX = "/api/v1/admin/search/reindex";
    private static final String STATUS = "/api/v1/admin/search/status";
    private static final ClientAddress CLIENT =
            ClientAddress.parse("203.0.113.9").orElseThrow();

    @Autowired
    private SearchReindexService reindexService;

    @Autowired
    private SearchProperties properties;

    @Autowired
    private MeiliHttpClient client;

    @Autowired
    private SearchDocumentSource source;

    @Autowired
    private StaticSearchContent staticContent;

    @Autowired
    private SearchReconciler reconciler;

    @Autowired
    private SearchReconcileSchedule reconcileSchedule;

    @Autowired
    private SearchOutboxRepository outboxRepository;

    @Autowired
    private SearchOutboxWorker worker;

    @Autowired
    private SearchMaintenanceLock lock;

    @Autowired
    private SearchMetrics metrics;

    @Autowired
    private RateLimiter rateLimiter;

    @Autowired
    private Clock clock;

    @Autowired
    private PostService postService;

    @Autowired
    private SearchService searchService;

    @Autowired
    private PostgresSearchProvider postgres;

    // ------------------------------------------------------------------------------------------------ dry run

    @Test
    void dry_run_only_counts_writes_nothing_is_the_default_and_counts_toward_rate_limit() throws Exception {
        publish("Dry run " + uniqueWord(), "noi dung", null, createCategory("Dry run " + uniqueWord(), null));
        reindex();
        String admin = freshAdmin();
        long lastTask = lastTaskUid();
        long documents = client.numberOfDocuments(INDEX);
        Map<String, Object> outbox = outboxCounts();
        Map<String, Long> expected = source.countByType();
        long total = expected.values().stream().mapToLong(Long::longValue).sum();

        JsonNode data =
                data(mockMvc.perform(post(REINDEX).param("dryRun", "true").header("Authorization", admin))
                        .andExpect(status().isOk()));
        assertThat(data.path("dryRun").asBoolean()).isTrue();
        assertThat(data.path("swapped").asBoolean()).isFalse();
        assertThat(data.path("index").asString()).isEqualTo(INDEX);
        assertThat(data.path("scanned").asLong()).isEqualTo(total);
        assertThat(data.path("skipped").asLong()).isEqualTo(total);
        assertThat(data.path("indexed").asLong()).isZero();
        assertThat(data.path("failed").asLong()).isZero();
        assertThat(data.path("indexDocuments").asLong()).isEqualTo(documents);
        assertThat(data.path("engineError").isNull()).isTrue();
        assertThat(data.path("catchUp").isNull()).isTrue();
        expected.forEach((type, count) -> assertThat(
                        data.path("documentsByType").path(type).asLong())
                .as(type)
                .isEqualTo(count));

        // No parameter means a dry run.
        assertThat(data(mockMvc.perform(post(REINDEX).header("Authorization", admin))
                                .andExpect(status().isOk()))
                        .path("dryRun")
                        .asBoolean())
                .isTrue();

        // No task queued (every Meilisearch write is a task), no secondary index, outbox untouched.
        assertThat(lastTaskUid()).isEqualTo(lastTask);
        assertThat(client.numberOfDocuments(INDEX)).isEqualTo(documents);
        assertThat(client.indexExists(BUILD)).isFalse();
        assertThat(outboxCounts()).isEqualTo(outbox);

        // Three per 10 minutes for one admin, dry runs included.
        mockMvc.perform(post(REINDEX).param("dryRun", "true").header("Authorization", admin))
                .andExpect(status().isOk());
        mockMvc.perform(post(REINDEX).param("dryRun", "true").header("Authorization", admin))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("RATE_LIMITED"));
    }

    // ------------------------------------------------------------------------------------------------ real run

    @Test
    void first_run_renames_later_runs_swap_and_rerun_gives_same_index() throws Exception {
        String word = uniqueWord();
        UUID post = publish("Rebuilt " + word, "Body " + word, null, createCategory("Rebuild " + word, null));
        indexer.dropIndex(INDEX);
        assertThat(client.indexExists(INDEX)).isFalse();
        long expected = source.countByType().values().stream()
                .mapToLong(Long::longValue)
                .sum();

        // No index yet: the build is renamed into the serving index.
        ReindexReport first = reindexService.reindex(UUID.randomUUID(), false);
        assertThat(first.dryRun()).isFalse();
        assertThat(first.swapped()).isTrue();
        assertThat(first.scanned()).isEqualTo(expected);
        assertThat(first.indexed()).isEqualTo(expected);
        assertThat(first.failed()).isZero();
        assertThat(first.indexDocuments()).isEqualTo(expected);
        assertThat(first.documentsByType().values().stream()
                        .mapToLong(Long::longValue)
                        .sum())
                .isEqualTo(expected);
        assertThat(first.catchUp().outcome()).isEqualTo(ReconcileReport.Outcome.COMPLETED);
        assertThat(first.catchUp().upserted() + first.catchUp().deleted()).isZero();
        assertThat(client.indexExists(INDEX)).isTrue();
        assertThat(client.indexExists(BUILD)).isFalse();
        assertThat(indexedDocument(INDEX, "post-" + post)).isNotNull();
        // Settings travel with the new index: C++ is one word (nonSeparatorTokens).
        assertThat(masterGet("/indexes/" + INDEX + "/settings")
                        .path("nonSeparatorTokens")
                        .toString())
                .contains("+", "#");
        JsonNode found = search("q", word);
        assertThat(found.path("engine").asString()).isEqualTo("meilisearch");
        assertThat(types(found)).contains("post");

        // Second run: swap with the existing index, the old index is deleted; same documents, same hash.
        Map<String, String> hashes = hashes(INDEX);
        ReindexReport second = reindexService.reindex(UUID.randomUUID(), false);
        assertThat(second.swapped()).isTrue();
        assertThat(second.scanned()).isEqualTo(expected);
        assertThat(second.catchUp().upserted() + second.catchUp().deleted()).isZero();
        assertThat(client.indexExists(BUILD)).isFalse();
        assertThat(hashes(INDEX)).isEqualTo(hashes);
        assertThat(lock.held()).isFalse();
    }

    @Test
    void second_reindex_while_running_is_409_and_scheduled_reconcile_skips_its_turn() throws Exception {
        reindex();
        CountDownLatch building = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        SearchReindexService slow = reindexWith(sourceWithHook(() -> {
            building.countDown();
            await(release);
        }));
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            Future<ReindexReport> first = executor.submit(() -> slow.reindex(UUID.randomUUID(), false));
            assertThat(building.await(60, TimeUnit.SECONDS)).isTrue();
            ReconcileReport lastReconciliation = metrics.lastReconciliation();

            String admin = freshAdmin();
            mockMvc.perform(post(REINDEX).param("dryRun", "false").header("Authorization", admin))
                    .andExpect(status().isConflict())
                    .andExpect(jsonPath("$.error.code").value("SEARCH_REINDEX_RUNNING"));
            assertThat(data(mockMvc.perform(get(STATUS).header("Authorization", admin))
                                    .andExpect(status().isOk()))
                            .path("maintenanceRunning")
                            .asBoolean())
                    .isTrue();
            reconcileSchedule.run();
            assertThat(metrics.lastReconciliation()).isSameAs(lastReconciliation);

            release.countDown();
            assertThat(first.get(120, TimeUnit.SECONDS).swapped()).isTrue();
        } finally {
            release.countDown();
            executor.shutdownNow();
        }
        assertThat(lock.held()).isFalse();
    }

    @Test
    void failure_before_swap_leaves_serving_index_untouched_and_build_is_deleted() throws Exception {
        String word = uniqueWord();
        publish("Kept " + word, "noi dung", null, createCategory("Keep " + word, null));
        reindex();
        long documents = client.numberOfDocuments(INDEX);
        Map<String, String> hashes = hashes(INDEX);

        // Someone writes more into the build: its document count differs from the number written.
        SearchReindexService broken = reindexWith(sourceWithHook(() -> client.waitForTask(
                client.addOrReplaceDocuments(BUILD, List.of(Map.of("id", "post-" + UUID.randomUUID(), "type", "post"))),
                Duration.ofSeconds(30))));
        assertThatThrownBy(() -> broken.reindex(UUID.randomUUID(), false))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.SEARCH_REINDEX_FAILED);
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_GATEWAY);
                    assertThat(e.getMessage()).contains("COUNT_CHECK").contains("The live index was not changed");
                });

        assertThat(client.numberOfDocuments(INDEX)).isEqualTo(documents);
        assertThat(hashes(INDEX)).isEqualTo(hashes);
        assertThat(client.indexExists(BUILD)).isFalse();
        assertThat(lock.held()).isFalse();
        assertThat(search("q", word).path("engine").asString()).isEqualTo("meilisearch");
    }

    @Test
    void changes_during_build_written_by_worker_to_old_index_are_still_present_after_swap() throws Exception {
        String word = uniqueWord();
        Taxon category = createCategory("Window " + word, null);
        UUID edited = publish("Before " + word, "noi dung", null, category);
        UUID unpublished = publish("Will unpublish " + word, "noi dung", null, category);
        reindex();
        clearOutbox();

        AtomicReference<UUID> added = new AtomicReference<>();
        SearchReindexService windowed = reindexWith(sourceWithHook(() -> {
            // Every post was read for the build. Changes go through the real service (writing the outbox), the worker
            // syncs them into the serving index, i.e. the OLD one: after the swap they are lost, only the reconcile
            // pass right after brings them back.
            postService.update(
                    edited,
                    new PostUpdateRequest("Sau " + word, null, "noi dung", category.id(), Set.of(), null),
                    SeedAdmin.ID);
            postService.unpublish(unpublished);
            added.set(unchecked(() -> publish("New " + word, "noi dung", null, category)));
            assertThat(worker.runOnce().failed()).isZero();
            assertThat(outboxCounts().get("total")).isEqualTo(0L);
        }));

        ReindexReport report = windowed.reindex(UUID.randomUUID(), false);

        assertThat(indexedDocument(INDEX, "post-" + edited).path("title").asString())
                .isEqualTo("Sau " + word);
        assertThat(indexedDocument(INDEX, "post-" + added.get())).isNotNull();
        assertThat(indexedDocument(INDEX, "post-" + unpublished)).isNull();
        assertThat(report.catchUp().outcome()).isEqualTo(ReconcileReport.Outcome.COMPLETED);
        assertThat(report.catchUp().upserted()).isGreaterThanOrEqualTo(2);
        assertThat(report.catchUp().deleted()).isGreaterThanOrEqualTo(1);
        assertThat(report.indexed())
                .isEqualTo(report.scanned() + report.catchUp().upserted());
        assertThat(report.deleted()).isEqualTo(report.catchUp().deleted());
        assertThat(hashes(INDEX).keySet()).containsAll(expectedIds());
        assertThat(client.numberOfDocuments(INDEX)).isEqualTo(expectedIds().size());
    }

    // ------------------------------------------------------------------------------------------------ status

    @Test
    void status_has_all_fields_matches_counts_and_leaks_neither_key_nor_url() throws Exception {
        publish("Status " + uniqueWord(), "noi dung", null, createCategory("Status " + uniqueWord(), null));
        reindex();
        String body = mockMvc.perform(get(STATUS).header("Authorization", freshAdmin()))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        JsonNode data = objectMapper.readTree(body).path("data");

        assertThat(data.path("engine").asString()).isEqualTo("meilisearch");
        assertThat(data.path("indexing").asBoolean()).isTrue();
        assertThat(data.path("maintenanceRunning").asBoolean()).isFalse();
        JsonNode meili = data.path("meilisearch");
        assertThat(meili.path("configured").asBoolean()).isTrue();
        assertThat(meili.path("reachable").asBoolean()).isTrue();
        assertThat(meili.path("version").asString()).isEqualTo("1.54.3");
        assertThat(meili.path("error").isNull()).isTrue();
        JsonNode index = data.path("index");
        long documents = client.numberOfDocuments(INDEX);
        assertThat(index.path("name").asString()).isEqualTo(INDEX);
        assertThat(index.path("exists").asBoolean()).isTrue();
        assertThat(index.path("documents").asLong()).isEqualTo(documents);
        long byType = 0;
        for (JsonNode count : index.path("byType")) {
            byType += count.asLong();
        }
        assertThat(byType).isEqualTo(documents);
        // Just built from the DB: index and PostgreSQL match for every type.
        source.countByType().forEach((type, count) -> {
            assertThat(data.path("database").path("byType").path(type).asLong())
                    .as(type)
                    .isEqualTo(count);
            assertThat(index.path("byType").path(type).asLong()).as(type).isEqualTo(count);
        });
        for (String field : List.of("pending", "processing", "failed")) {
            assertThat(data.path("outbox").path(field).isIntegralNumber())
                    .as(field)
                    .isTrue();
        }
        assertThat(data.path("outbox").has("oldestPendingAgeSeconds")).isTrue();
        assertThat(data.has("lastReconciliation")).isTrue();
        for (String field :
                List.of("degradedRequests", "staleHitsDropped", "deepPageFallbacks", "outboxSynced", "outboxFailed")) {
            assertThat(data.path("counters").path(field).isIntegralNumber())
                    .as(field)
                    .isTrue();
        }
        assertThat(data.path("counters").has("lastDegradedCode")).isTrue();
        assertNoSecrets(body);

        // A URL carrying a user name and password (unreachable engine): none of it leaks out.
        String withCredentials = objectMapper.writeValueAsString(
                statusService(meiliProperties("http://operator:s3cr3t-in-url@127.0.0.1:1", INDEX))
                        .status());
        assertThat(withCredentials).doesNotContain("s3cr3t-in-url").doesNotContain("operator:");
        assertNoSecrets(withCredentials);
        assertThat(objectMapper
                        .readTree(withCredentials)
                        .path("meilisearch")
                        .path("reachable")
                        .asBoolean(false))
                .isFalse();

        // Not configured: Meilisearch is not queried at all, the PostgreSQL counts are still there.
        SearchStatusResponse unconfigured =
                statusService(meiliProperties("", INDEX)).status();
        assertThat(unconfigured.indexing()).isFalse();
        assertThat(unconfigured.meilisearch().configured()).isFalse();
        assertThat(unconfigured.meilisearch().reachable()).isNull();
        assertThat(unconfigured.index().exists()).isNull();
        assertThat(unconfigured.database().byType()).isEqualTo(source.countByType());
    }

    // ------------------------------------------------------------------------------------------------ quay lui

    @Test
    void
            rollback_by_setting_only_search_engine_postgres_returns_postgres_engine_not_degraded_without_calling_meilisearch()
                    throws Exception {
        String word = uniqueWord();
        UUID post = publish("Quay lui " + word, "noi dung " + word, null, createCategory("Quay lui " + word, null));
        reindex();
        SearchResponse meili = searchService.search(word, "post", null, 0, 10, null, null, null, CLIENT);
        assertThat(meili.engine()).isEqualTo(Engine.MEILISEARCH);
        assertThat(meili.degraded()).isFalse();

        // Same URL, key, index, same beans: only the engine changes.
        MeiliSearchProvider untouched = mock(MeiliSearchProvider.class);
        long degraded = metrics.snapshot().degradedRequests();
        SearchService rolledBack = new SearchService(
                new SearchProperties(Engine.POSTGRES, properties.meili()), rateLimiter, postgres, untouched, metrics);
        SearchResponse answer = rolledBack.search(word, "post", null, 0, 10, null, null, null, CLIENT);

        assertThat(answer.engine()).isEqualTo(Engine.POSTGRES);
        assertThat(answer.degraded()).isFalse();
        assertThat(itemIds(answer)).isEqualTo(itemIds(meili)).containsExactly("post:" + slugOf(post));
        verifyNoInteractions(untouched);
        assertThat(metrics.snapshot().degradedRequests()).isEqualTo(degraded);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    private SearchReindexService reindexWith(SearchDocumentSource buildSource) {
        return new SearchReindexService(
                properties, client, indexer, buildSource, reconciler, outboxRepository, lock, rateLimiter, clock);
    }

    private SearchStatusService statusService(SearchProperties meiliConfig) {
        return new SearchStatusService(
                meiliConfig,
                new MeiliHttpClient(meiliConfig, objectMapper),
                source,
                outboxRepository,
                metrics,
                lock,
                clock);
    }

    /**
     * The real source for the build; {@code hook} runs once right after the first non-post batch (every post already
     * read).
     */
    private SearchDocumentSource sourceWithHook(Runnable hook) {
        return new SearchDocumentSource(jdbcTemplate, staticContent) {
            @Override
            public void forEachBatch(int batchSize, Consumer<List<SearchDocument>> sink) {
                AtomicBoolean ran = new AtomicBoolean();
                super.forEachBatch(batchSize, batch -> {
                    sink.accept(batch);
                    if (!batch.getFirst().type().equals("post") && ran.compareAndSet(false, true)) {
                        hook.run();
                    }
                });
            }
        };
    }

    /** id -> contentHash of every document in the index. */
    private Map<String, String> hashes(String index) {
        Map<String, String> hashes = new HashMap<>();
        long offset = 0;
        while (true) {
            MeiliHttpClient.DocumentPage page =
                    client.fetchDocuments(index, offset, 1000, List.of("id", "contentHash"));
            page.results()
                    .forEach(document -> hashes.put(
                            document.path("id").asString(),
                            document.path("contentHash").asString()));
            offset += page.results().size();
            if (page.results().isEmpty() || offset >= page.total()) {
                return hashes;
            }
        }
    }

    /** Ids of every document the DB currently lets show. */
    private Set<String> expectedIds() {
        Set<String> ids = new java.util.HashSet<>();
        source.forEachBatch(200, batch -> batch.forEach(document -> ids.add(document.id())));
        return ids;
    }

    private long lastTaskUid() throws Exception {
        return masterGet("/tasks?limit=1").path("results").get(0).path("uid").asLong();
    }

    private Map<String, Object> outboxCounts() {
        return jdbcTemplate.queryForMap(
                "SELECT count(*) AS total, count(*) FILTER (WHERE state = 'FAILED') AS failed " + "FROM search_outbox");
    }

    private void clearOutbox() {
        assertThat(jdbcTemplate.queryForObject("SELECT current_database()", String.class))
                .isEqualTo("meili_search_it");
        jdbcTemplate.update("DELETE FROM search_outbox");
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("data");
    }

    private static void assertNoSecrets(String json) {
        assertThat(json)
                .doesNotContain(MeiliTestContainer.MASTER_KEY)
                .doesNotContain(MeiliKeys.derive(MeiliTestContainer.MASTER_KEY, MeiliKeys.SEARCH.uid()))
                .doesNotContain(MeiliKeys.derive(MeiliTestContainer.MASTER_KEY, MeiliKeys.INDEXING.uid()))
                .doesNotContain(MeiliTestContainer.url())
                .doesNotContain(
                        MeiliTestContainer.CONTAINER.getHost() + ":" + MeiliTestContainer.CONTAINER.getMappedPort(7700))
                .doesNotContain("Bearer");
    }

    private static List<String> itemIds(SearchResponse response) {
        return response.groups().stream()
                .flatMap(group -> group.items().stream())
                .map(item -> item.id())
                .collect(Collectors.toList());
    }

    private static void await(CountDownLatch latch) {
        try {
            assertThat(latch.await(120, TimeUnit.SECONDS)).isTrue();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
    }

    @FunctionalInterface
    private interface ThrowingSupplier<T> {
        T get() throws Exception;
    }

    private static <T> T unchecked(ThrowingSupplier<T> supplier) {
        try {
            return supplier.get();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
