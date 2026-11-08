package com.blog.search;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.core.read.ListAppender;
import com.blog.fixtures.vi.SearchSnippetVi;
import com.blog.search.index.DocType;
import com.blog.search.index.SearchDocument;
import com.blog.search.index.SearchDocumentSource;
import com.blog.search.index.SearchIndexer;
import com.blog.search.index.SearchText;
import com.blog.search.meili.MeiliException;
import com.blog.search.meili.MeiliHttpClient;
import com.blog.search.meili.MeiliKeys;
import com.blog.search.meili.MeiliSettings;
import com.blog.search.meili.MeiliTask;
import com.blog.search.service.PostgresSearchProvider;
import com.blog.search.service.SearchMetrics;
import com.blog.search.service.SearchRequest;
import com.blog.search.service.SearchType;
import com.blog.search.service.StaticSearchContent;
import com.blog.support.MeiliTestContainer;
import com.blog.user.entity.User;
import com.blog.user.entity.UserStatus;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import tools.jackson.databind.JsonNode;

/**
 * {@code GET /api/v1/search} on a real Meilisearch (Testcontainers {@code getmeili/meilisearch:v1.54.3}): derived
 * keys and their scope, every content type with the same id, path and meta as Postgres, snippets and highlighting on
 * Vietnamese text and emoji, the filters and pagination of {@code /search}, fail closed while the index still holds
 * stale documents, and degraded when the engine hangs. No test depends on the exact ranking.
 */
class MeiliSearchIT extends MeiliIntegrationTest {

    private static final Pattern UUID_LIKE =
            Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");

    @Autowired
    private MeiliHttpClient client;

    @Autowired
    private PostgresSearchProvider postgres;

    @Autowired
    private SearchMetrics metrics;

    @Autowired
    private StaticSearchContent staticContent;

    @Autowired
    private SearchDocumentSource source;

    private final HttpClient http = HttpClient.newHttpClient();

    @Test
    void derived_keys_match_engine_search_key_only_searches_indexing_key_sees_swap_task() throws Exception {
        reindex();
        for (MeiliKeys.KeySpec spec : List.of(MeiliKeys.SEARCH, MeiliKeys.INDEXING)) {
            JsonNode key = client.getKey(spec.uid()).orElseThrow();
            // The value the engine keeps is exactly HMAC-SHA256(master, uid) computed in the backend.
            assertThat(key.path("key").asString())
                    .as(spec.name())
                    .isEqualTo(MeiliKeys.derive(MeiliTestContainer.MASTER_KEY, spec.uid()));
        }
        String searchKey = MeiliKeys.derive(MeiliTestContainer.MASTER_KEY, MeiliKeys.SEARCH.uid());
        assertThat(call(
                                "POST",
                                "/multi-search",
                                searchKey,
                                "{\"queries\":[{\"indexUid\":\"" + INDEX + "\",\"q\":\"x\"}]}")
                        .statusCode())
                .isEqualTo(200);
        assertThat(call("POST", "/indexes/" + INDEX + "/documents", searchKey, "[{\"id\":\"post-x\"}]")
                        .statusCode())
                .isEqualTo(403);
        assertThat(call("GET", "/keys", searchKey, null).statusCode()).isEqualTo(403);

        // The indexing key (indexes ["*"]) sees the index-swap task, a global task.
        String first = "content_it_swap_a";
        String second = "content_it_swap_b";
        client.waitForTask(client.createIndex(first), Duration.ofSeconds(30));
        client.waitForTask(client.createIndex(second), Duration.ofSeconds(30));
        long swap = client.swapIndexes(first, second);
        MeiliTask swapped = client.waitForTask(swap, Duration.ofSeconds(30));
        assertThat(swapped.status()).isEqualTo("succeeded");

        // A key limited to content_* does not see that task: why the indexing key must be ["*"].
        String scopedUid = UUID.randomUUID().toString();
        JsonNode scoped = client.createKey(Map.of(
                "uid",
                scopedUid,
                "actions",
                List.of("tasks.get"),
                "indexes",
                List.of("content_*"),
                "expiresAt",
                "2100-01-01T00:00:00Z"));
        try {
            assertThat(call("GET", "/tasks/" + swap, scoped.path("key").asString(), null)
                            .statusCode())
                    .isEqualTo(404);
        } finally {
            client.deleteKey(scopedUid);
            client.waitForTask(client.deleteIndex(first), Duration.ofSeconds(30));
            client.waitForTask(client.deleteIndex(second), Duration.ofSeconds(30));
        }
    }

    @Test
    void every_type_is_indexed_and_returned_with_same_id_path_meta_as_postgres() throws Exception {
        String marker = uniqueWord();
        Taxon category = createCategory("Category " + marker, "Category description");
        Taxon tag = createTag("Tag " + marker);
        Taxon series = insertSeries("Series " + marker, "Series description");
        User author = auth.createAuthor(marker + "@blog.local");
        UUID postId = publish("Post " + marker, "Post content", "Excerpt with " + marker, category, tag);
        setAuthor(postId, author.getId());
        putInSeries(postId, series, 1);
        createPost("Draft " + marker, "noi dung", null, category);
        reindex();

        JsonNode data = search("q", marker);
        assertThat(data.path("engine").asString()).isEqualTo("meilisearch");
        assertThat(data.path("degraded").asBoolean()).isFalse();
        assertThat(types(data)).containsExactly("post", "topic", "series", "author");
        // A draft is never indexed.
        assertThat(items(data, "post")).hasSize(1);
        assertThat(items(data, "post").getFirst().path("id").asString()).isEqualTo("post:" + slugOf(postId));
        assertThat(marked(items(data, "post").getFirst().path("title"))).containsExactly(marker);

        // Same query on Postgres: same id, path, meta and title for every row.
        for (String type : List.of("post", "topic", "series", "author")) {
            JsonNode meili = search("q", marker, "type", type);
            SearchType scope = SearchType.valueOf(type.toUpperCase());
            JsonNode pg = objectMapper.valueToTree(Map.of(
                    "groups", postgres.search(new SearchRequest(marker, scope, 10, 0, 10, null, List.of(), null))));
            assertThat(lines(meili, type)).as(type).isEqualTo(lines(pg, type));
            assertThat(groupOf(meili, type).path("total").asLong())
                    .isEqualTo(groupOf(pg, type).path("total").asLong());
        }

        // Static content: case studies and pages, same id and path.
        StaticSearchContent.CaseStudy study = staticContent.caseStudies().getFirst();
        JsonNode studies = search("q", study.title(), "type", "case-study");
        assertThat(items(studies, "case-study")).anySatisfy(item -> {
            assertThat(item.path("id").asString()).isEqualTo("case-study:" + study.slug());
            assertThat(item.path("href").asString()).isEqualTo(study.href());
            assertThat(joined(item.path("title"))).isEqualTo(study.title());
        });
        StaticSearchContent.Page page = staticContent.pages().getFirst();
        assertThat(items(search("q", page.title(), "type", "page"), "page")).anySatisfy(item -> {
            assertThat(item.path("id").asString()).isEqualTo("page:" + page.href());
            assertThat(joined(item.path("description"))).isEqualTo(page.description());
        });
        String owner = staticContent.owner().name();
        assertThat(items(search("q", owner, "type", "author"), "author")).anySatisfy(item -> {
            assertThat(item.path("id").asString()).isEqualTo("author:/about");
            assertThat(joined(item.path("title"))).isEqualTo(owner);
        });

        for (JsonNode group : data.path("groups")) {
            for (JsonNode item : group.path("items")) {
                assertThat(UUID_LIKE.matcher(item.path("id").asString()).find())
                        .as(item.toString())
                        .isFalse();
                assertThat(item.path("href").asString()).startsWith("/");
            }
        }
        assertThat(data.toString())
                .doesNotContain(
                        String.valueOf(SearchText.HIGHLIGHT_PRE),
                        String.valueOf(SearchText.HIGHLIGHT_POST),
                        "<em>",
                        "contentHash",
                        "sourceId",
                        MeiliTestContainer.MASTER_KEY,
                        MeiliKeys.derive(MeiliTestContainer.MASTER_KEY, MeiliKeys.SEARCH.uid()),
                        MeiliKeys.derive(MeiliTestContainer.MASTER_KEY, MeiliKeys.INDEXING.uid()));
    }

    @Test
    void snippet_around_body_match_and_vietnamese_emoji_never_5xx() throws Exception {
        String marker = uniqueWord();
        String rocket = Character.toString(0x1F680);
        String family = Character.toString(0x1F468)
                + (char) 0x200D
                + Character.toString(0x1F469)
                + (char) 0x200D
                + Character.toString(0x1F467);
        StringBuilder body = new StringBuilder(SearchSnippetVi.INTRO_HEADING);
        for (int i = 0; i < 60; i++) {
            body.append(SearchSnippetVi.SENTENCE_NUMBER_PREFIX).append(i).append(SearchSnippetVi.ABOUT_HANOI);
        }
        body.append(SearchSnippetVi.ROAD_START)
                .append(rocket)
                .append(SearchSnippetVi.GO_TO_SCHOOL)
                .append(family)
                .append(SearchSnippetVi.EVERY_DAY_PRIORITY)
                .append(marker)
                .append(SearchSnippetVi.HERE_CODE)
                .append(rocket)
                .append(rocket)
                .append(SearchSnippetVi.D_STROKE_VARIANTS)
                .append(SearchSnippetVi.STACKED_DIACRITICS)
                .append(family)
                .append(". ");
        for (int i = 0; i < 60; i++) {
            body.append(SearchSnippetVi.CLOSING_NUMBER_PREFIX)
                    .append(i)
                    .append(SearchSnippetVi.ALSO_HAS_ROAD)
                    .append(rocket)
                    .append(". ");
        }
        Taxon category = createCategory(SearchSnippetVi.EXCERPT_CATEGORY_PREFIX + marker, null);
        UUID postId = publish(
                SearchSnippetVi.NOTES_PREFIX + rocket + SearchSnippetVi.STREET_BETWEEN + marker.substring(0, 6),
                body.toString(),
                SearchSnippetVi.UNRELATED_SUMMARY,
                category);
        reindex();

        // Matches only in the post body: the description is a snippet around the match, highlighted, not a summary.
        JsonNode item = items(search("q", marker, "type", "post"), "post").getFirst();
        assertThat(item.path("id").asString()).isEqualTo("post:" + slugOf(postId));
        String snippet = joined(item.path("description"));
        assertThat(marked(item.path("description"))).contains(marker);
        assertThat(snippet)
                .contains(SearchSnippetVi.PRIORITY, marker)
                .doesNotContain(SearchSnippetVi.UNRELATED_SUMMARY, "`", "##");
        assertThat(snippet.split("\\s+").length).isLessThan(60);

        int degradedBefore = (int) metrics.snapshot().degradedRequests();
        List<String> queries = List.of(
                marker,
                SearchSnippetVi.QUERY_ROAD + marker,
                "duong " + marker,
                "uu tien " + marker,
                SearchSnippetVi.QUERY_PRIORITY_SHORT + marker,
                rocket + " " + marker,
                family + " " + marker,
                SearchSnippetVi.QUERY_D_STROKE + marker,
                SearchSnippetVi.QUERY_ETH + marker,
                SearchSnippetVi.QUERY_U_DOT + marker,
                marker.substring(0, 6),
                SearchSnippetVi.QUERY_ROAD_STREET,
                "duong pho",
                "ghi chep " + rocket,
                SearchSnippetVi.QUERY_GO_TO_SCHOOL,
                "di hoc " + marker,
                marker + " json.loads",
                rocket);
        for (String q : queries) {
            for (String type : List.of("all", "post")) {
                JsonNode data = search("q", q, "type", type);
                assertThat(data.path("degraded").asBoolean())
                        .as("q=%s type=%s", q, type)
                        .isFalse();
                assertThat(data.path("engine").asString()).as("q=%s", q).isEqualTo("meilisearch");
                for (JsonNode group : data.path("groups")) {
                    for (JsonNode row : group.path("items")) {
                        assertThat(row.toString())
                                .doesNotContain(
                                        String.valueOf(SearchText.HIGHLIGHT_PRE),
                                        String.valueOf(SearchText.HIGHLIGHT_POST));
                    }
                }
            }
        }
        assertThat(metrics.snapshot().degradedRequests()).isEqualTo(degradedBefore);
        // Title with emoji and diacritics: the segments rejoin into exactly the title (the accessible name of the
        // link in the frontend).
        JsonNode titled = items(
                        search("q", SearchSnippetVi.QUERY_ROAD_STREET_SPACE + marker.substring(0, 6), "type", "post"),
                        "post")
                .getFirst();
        assertThat(joined(titled.path("title")))
                .isEqualTo(SearchSnippetVi.NOTES_PREFIX
                        + rocket
                        + SearchSnippetVi.STREET_BETWEEN
                        + marker.substring(0, 6));
    }

    @Test
    void unpublishing_suspending_author_or_editing_body_takes_effect_at_once_despite_stale_index() throws Exception {
        String withdrawn = uniqueWord();
        String locked = uniqueWord();
        String edited = uniqueWord();
        String secret = uniqueWord();
        Taxon category = createCategory("Hidden " + withdrawn, null);
        UUID first = publish("Will unpublish " + withdrawn, "noi dung", null, category);
        User writer = auth.createReader(auth.nextGithubId(), locked);
        UUID second = publish("Post of " + locked, "noi dung", null, createCategory("Locked " + locked, null));
        setAuthor(second, writer.getId());
        UUID third = publish(
                "Edited " + edited,
                "Start of post. Secret sentence " + secret + " in the middle. End of post.",
                "Excerpt",
                createCategory("Edited " + edited, null));
        reindex();
        assertThat(types(search("q", withdrawn))).containsExactly("post", "topic");
        assertThat(types(search("q", locked))).containsExactly("post", "topic", "author");
        assertThat(joined(items(search("q", secret, "type", "post"), "post")
                        .getFirst()
                        .path("description")))
                .contains(secret);

        long staleBefore = metrics.snapshot().staleHitsDropped();
        mockMvc.perform(post("/api/v1/admin/posts/" + first + "/unpublish").header("Authorization", admin))
                .andExpect(status().isOk());
        auth.setStatus(writer.getId(), UserStatus.SUSPENDED);
        jdbcTemplate.update("UPDATE posts SET content = ? WHERE id = ?", "Start of post. End of post.", third);

        // The index has not changed (there is no sync yet), but Postgres has: no post, topic or author is left.
        JsonNode afterUnpublish = search("q", withdrawn);
        assertThat(afterUnpublish.path("engine").asString()).isEqualTo("meilisearch");
        assertThat(afterUnpublish.path("degraded").asBoolean()).isFalse();
        assertThat(afterUnpublish.path("groups")).isEmpty();
        assertThat(search("q", withdrawn, "type", "post").path("groups")).isEmpty();
        // Posts of a suspended author: no posts, no author; the topic remains (counted like /topics, like Postgres).
        assertThat(types(search("q", locked))).containsExactly("topic");
        assertThat(search("q", locked, "type", "author").path("groups")).isEmpty();
        // The post is still public but the sentence was edited out of the body: it never shows again in a snippet.
        JsonNode stale = search("q", secret, "type", "post");
        assertThat(stale.path("groups").toString()).doesNotContain(secret);
        assertThat(metrics.snapshot().staleHitsDropped()).isGreaterThanOrEqualTo(staleBefore + 4);

        // Rebuild the index: the stale documents vanish from the engine.
        reindex();
        long staleAfterRebuild = metrics.snapshot().staleHitsDropped();
        assertThat(search("q", withdrawn).path("groups")).isEmpty();
        assertThat(search("q", secret).path("groups")).isEmpty();
        assertThat(metrics.snapshot().staleHitsDropped()).isEqualTo(staleAfterRebuild);
        auth.setStatus(writer.getId(), UserStatus.ACTIVE);
    }

    @Test
    void type_post_filters_and_pagination_listing_without_text_and_deep_page() throws Exception {
        String marker = uniqueWord();
        Taxon category = createCategory("Filter " + marker, null);
        Taxon a = createTag("Tag a " + marker);
        Taxon b = createTag("Tag b " + marker);
        Taxon series = insertSeries("Chain " + marker, null);
        List<UUID> both = new ArrayList<>();
        for (int i = 1; i <= 3; i++) {
            both.add(publish("Filter " + marker + " number " + i, "noi dung", null, category, a, b));
        }
        putInSeries(both.get(0), series, 1);
        putInSeries(both.get(2), series, 2);
        publish("Only tag a " + marker, "noi dung", null, category, a);
        publish("Outside section " + marker, "noi dung", null, createCategory("Other " + marker, null), a, b);
        reindex();

        for (String q : List.of(marker, "")) {
            List<String> slugs = new ArrayList<>();
            for (int page = 0; page <= 2; page++) {
                JsonNode data = search(
                        "type",
                        "post",
                        "q",
                        q,
                        "category",
                        category.slug(),
                        "tag",
                        a.slug(),
                        "tag",
                        b.slug(),
                        "page",
                        String.valueOf(page),
                        "size",
                        "2");
                assertThat(data.path("engine").asString()).isEqualTo("meilisearch");
                JsonNode group = groupOf(data, "post");
                assertThat(group.path("total").asInt()).isEqualTo(3);
                assertThat(group.path("totalPages").asInt()).isEqualTo(2);
                assertThat(group.path("page").asInt()).isEqualTo(page);
                group.path("items")
                        .forEach(
                                item -> slugs.add(item.path("post").path("slug").asString()));
            }
            List<String> expected = both.stream().map(this::slugOf).toList();
            assertThat(slugs).as("q=%s", q).containsExactlyInAnyOrderElementsOf(expected);
            if (q.isEmpty()) {
                // No text: newest first, exactly like Postgres.
                assertThat(slugs).containsExactlyElementsOf(expected.reversed());
            }
        }
        JsonNode inSeries = search("type", "post", "q", marker, "series", series.slug());
        assertThat(groupOf(inSeries, "post").path("total").asInt()).isEqualTo(2);

        // A malformed slug or a filter string: no posts, no error, never reaches the engine.
        for (String hostile :
                List.of(category.slug().toUpperCase(), category.slug() + "\" OR type = \"post", "x OR 1 = 1")) {
            assertThat(search("type", "post", "q", marker, "category", hostile).path("groups"))
                    .as(hostile)
                    .isEmpty();
            assertThat(search("type", "post", "q", marker, "tag", hostile).path("groups"))
                    .as(hostile)
                    .isEmpty();
        }

        // A deep page past Meilisearch's 1000 cap: Postgres answers, not degraded.
        long deepBefore = metrics.snapshot().deepPageFallbacks();
        JsonNode deep = search("type", "post", "q", marker, "page", "100", "size", "10");
        assertThat(deep.path("engine").asString()).isEqualTo("postgres");
        assertThat(deep.path("degraded").asBoolean()).isFalse();
        assertThat(groupOf(deep, "post").path("total").asInt()).isEqualTo(5);
        assertThat(metrics.snapshot().deepPageFallbacks()).isEqualTo(deepBefore + 1);
    }

    @Test
    void hung_engine_gives_postgres_results_degraded_bad_q_still_400_and_q_not_logged() throws Exception {
        String marker = uniqueWord();
        UUID postId = publish("Fallback post " + marker, "noi dung", null, createCategory("Fallback " + marker, null));
        reindex();
        assertThat(search("q", marker).path("engine").asString()).isEqualTo("meilisearch");

        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        root.addAppender(logs);
        long degradedBefore = metrics.snapshot().degradedRequests();
        MeiliTestContainer.pause();
        try {
            long started = System.nanoTime();
            JsonNode data = search("q", marker);
            assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofSeconds(5));
            assertThat(data.path("degraded").asBoolean()).isTrue();
            assertThat(data.path("engine").asString()).isEqualTo("postgres");
            assertThat(items(data, "post").getFirst().path("id").asString()).isEqualTo("post:" + slugOf(postId));

            JsonNode tab = search("q", marker, "type", "post");
            assertThat(tab.path("degraded").asBoolean()).isTrue();
            assertThat(groupOf(tab, "post").path("total").asInt()).isEqualTo(1);

            // No results is still degraded when the engine is broken: the answer is not Meilisearch's.
            assertThat(search("q", uniqueWord()).path("degraded").asBoolean()).isTrue();

            // Bad parameter: 400 before any engine, not degraded.
            mockMvc.perform(request("q", marker + "a".repeat(200)))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
            mockMvc.perform(request("q", marker, "type", marker)).andExpect(status().isBadRequest());
        } finally {
            MeiliTestContainer.unpause();
            root.detachAppender(logs);
        }
        SearchMetrics.Snapshot snapshot = metrics.snapshot();
        assertThat(snapshot.degradedRequests()).isEqualTo(degradedBefore + 3);
        assertThat(snapshot.lastFailure()).isIn(MeiliException.Code.TIMEOUT, MeiliException.Code.CONNECTION_FAILED);
        assertThat(snapshot.lastDegradedAt()).isNotNull();

        // The engine is back: the next call is Meilisearch, no restart needed.
        JsonNode back = search("q", marker);
        assertThat(back.path("engine").asString()).isEqualTo("meilisearch");
        assertThat(back.path("degraded").asBoolean()).isFalse();

        assertThat(logs.list)
                .anySatisfy(event -> assertThat(event.getFormattedMessage()).contains("search degraded to postgres"));
        for (ILoggingEvent event : logs.list) {
            assertThat(event.getFormattedMessage()).doesNotContain(marker, MeiliTestContainer.MASTER_KEY);
            for (IThrowableProxy thrown = event.getThrowableProxy(); thrown != null; thrown = thrown.getCause()) {
                assertThat(String.valueOf(thrown.getMessage())).doesNotContain(marker);
            }
        }
    }

    @Test
    void batched_read_source_is_capped_without_duplicates_or_gaps_and_indexer_writes_deletes_by_id() throws Exception {
        String marker = uniqueWord();
        Taxon category = createCategory("Batch " + marker, null);
        Taxon tag = createTag("Batch tag " + marker);
        List<UUID> posts = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            posts.add(publish("Batch " + marker + " number " + i, "noi dung " + i, null, category, tag));
        }
        UUID draft = createPost("Draft batch " + marker, "noi dung", null, category);

        List<List<SearchDocument>> small = new ArrayList<>();
        source.forEachBatch(2, small::add);
        List<SearchDocument> all = new ArrayList<>();
        source.forEachBatch(1000, all::addAll);
        assertThat(small).allSatisfy(batch -> assertThat(batch).hasSizeBetween(1, 2));
        List<String> ids =
                small.stream().flatMap(List::stream).map(SearchDocument::id).toList();
        assertThat(ids)
                .doesNotHaveDuplicates()
                .containsExactlyInAnyOrderElementsOf(
                        all.stream().map(SearchDocument::id).toList())
                .contains("post-" + posts.getFirst(), "category-" + category.id(), "tag-" + tag.id())
                .doesNotContain("post-" + draft);

        // By id (the worker): only what is still public, same document and same hash as a full build.
        List<SearchDocument> loaded = source.load(DocType.POST, List.of(posts.getFirst(), draft, UUID.randomUUID()));
        assertThat(loaded).extracting(SearchDocument::id).containsExactly("post-" + posts.getFirst());
        assertThat(loaded.getFirst())
                .isEqualTo(all.stream()
                        .filter(document -> document.id().equals("post-" + posts.getFirst()))
                        .findFirst()
                        .orElseThrow());
        assertThat(loaded.getFirst().tagSlugs()).containsExactly(tag.slug());
        assertThat(loaded.getFirst().categorySlug()).isEqualTo(category.slug());
        assertThat(source.load(DocType.CATEGORY, List.of(category.id()))).hasSize(1);
        assertThat(source.load(DocType.TAG, List.of())).isEmpty();

        SearchIndexer.BuildReport report = indexer.build(INDEX);
        assertThat(report.documents()).isEqualTo(all.size());
        assertThat(client.numberOfDocuments(INDEX)).isEqualTo(all.size());
        indexer.delete(INDEX, List.of("post-" + posts.get(1), "post-khong-co"));
        assertThat(client.numberOfDocuments(INDEX)).isEqualTo(all.size() - 1);
        indexer.upsert(INDEX, source.load(DocType.POST, List.of(posts.get(1))));
        assertThat(client.numberOfDocuments(INDEX)).isEqualTo(all.size());
    }

    @Test
    void taxonomy_and_author_documents_list_exactly_the_languages_of_their_published_posts() throws Exception {
        LanguageData data = bilingualData();
        reindex();

        assertThat(languagesOf(DocType.CATEGORY, data.both().id())).containsExactly("en", "vi");
        assertThat(languagesOf(DocType.CATEGORY, data.viOnly().id())).containsExactly("vi");
        assertThat(languagesOf(DocType.CATEGORY, data.enOnly().id())).containsExactly("en");
        assertThat(languagesOf(DocType.TAG, data.tag().id())).containsExactly("en", "vi");
        assertThat(languagesOf(DocType.SERIES, data.series().id())).containsExactly("en", "vi");
        assertThat(languagesOf(DocType.AUTHOR, data.viAuthor().getId())).containsExactly("vi");
        assertThat(languagesOf(DocType.AUTHOR, data.enAuthor().getId())).containsExactly("en");
        // A draft or an unpublished post contributes no language: the category has no language list at all.
        for (Taxon hidden : List.of(data.enDraft(), data.enUnpublished())) {
            assertThat(languagesOf(DocType.CATEGORY, hidden.id())).isEmpty();
        }
        // What the index holds is the same document.
        JsonNode indexed = indexedDocument(INDEX, "category-" + data.both().id());
        List<String> indexedLanguages = new ArrayList<>();
        indexed.path("language").forEach(language -> indexedLanguages.add(language.asString()));
        assertThat(indexedLanguages).containsExactly("en", "vi");
    }

    @Test
    void a_rejected_language_filter_falls_back_to_postgres_and_a_reindex_restores_the_engine() throws Exception {
        LanguageData data = bilingualData();
        reindex();
        assertThat(search("q", data.marker(), "lang", "en").path("degraded").asBoolean())
                .isFalse();

        // An index built before the setting existed: the engine rejects the language filter.
        List<String> withoutLanguage = MeiliSettings.FILTERABLE.stream()
                .filter(attribute -> !attribute.equals("language"))
                .toList();
        try {
            client.waitForTask(
                    client.updateSettings(INDEX, Map.of("filterableAttributes", withoutLanguage)),
                    Duration.ofSeconds(30));

            JsonNode english = search("q", data.marker(), "lang", "en");
            assertThat(english.path("degraded").asBoolean()).isTrue();
            assertThat(english.path("engine").asString()).isEqualTo("postgres");
            assertThat(items(english, "post"))
                    .extracting(item -> item.path("id").asString())
                    .containsExactlyInAnyOrder(
                            "post:" + slugOf(data.enTranslation()), "post:" + slugOf(data.enOnlyPost()));
            assertThat(items(english, "topic"))
                    .extracting(item -> item.path("id").asString())
                    .doesNotContain(
                            "category:" + data.viOnly().slug(),
                            "category:" + data.enDraft().slug());
            // Without a language the filter is not sent: the engine still answers.
            assertThat(search("q", data.marker()).path("degraded").asBoolean()).isFalse();
        } finally {
            reindex();
        }
        JsonNode back = search("q", data.marker(), "lang", "en");
        assertThat(back.path("degraded").asBoolean()).isFalse();
        assertThat(back.path("engine").asString()).isEqualTo("meilisearch");
    }

    // ------------------------------------------------------------------------------------------------ helpers

    /** The language list of a document built from the database; empty when the document has none. */
    private List<String> languagesOf(DocType type, UUID id) {
        List<SearchDocument> documents = source.load(type, List.of(id));
        if (documents.isEmpty()) {
            return List.of();
        }
        Object language = documents.getFirst().language();
        return language == null
                ? List.of()
                : ((List<?>) language).stream().map(String::valueOf).toList();
    }

    /** Each row of the group: id -> href, meta, rejoined title, post slug; order is ignored. */
    private static Map<String, String> lines(JsonNode data, String type) {
        Map<String, String> lines = new HashMap<>();
        groupOf(data, type)
                .path("items")
                .forEach(item -> lines.put(
                        item.path("id").asString(),
                        item.path("href").asString() + " | " + item.path("meta") + " | " + joined(item.path("title"))
                                + " | " + item.path("post").path("slug").asString("")));
        return lines;
    }

    private HttpResponse<String> call(String method, String path, String key, String body) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(MeiliTestContainer.url() + path))
                .header("Authorization", "Bearer " + key)
                .header("Content-Type", "application/json");
        request.method(
                method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }
}
