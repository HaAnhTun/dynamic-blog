package com.blog.search;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.auth.oauth.GithubProfile;
import com.blog.category.dto.CategoryRequest;
import com.blog.category.service.CategoryService;
import com.blog.common.security.SeedAdmin;
import com.blog.post.dto.PostUpdateRequest;
import com.blog.post.service.PostService;
import com.blog.search.config.SearchProperties;
import com.blog.search.index.DocType;
import com.blog.search.index.SearchDocumentSource;
import com.blog.search.index.SearchIndexer;
import com.blog.search.meili.MeiliHttpClient;
import com.blog.search.meili.MeiliKeys;
import com.blog.search.service.SearchMetrics;
import com.blog.search.service.StaticSearchContent;
import com.blog.search.sync.SearchOutbox;
import com.blog.search.sync.SearchOutboxRepository;
import com.blog.search.sync.SearchOutboxWorker;
import com.blog.search.sync.SearchOutboxWorker.RunSummary;
import com.blog.series.dto.SeriesRequest;
import com.blog.series.service.SeriesService;
import com.blog.support.MeiliTestContainer;
import com.blog.tag.dto.TagRequest;
import com.blog.tag.service.TagService;
import com.blog.user.entity.User;
import com.blog.user.entity.UserStatus;
import com.blog.user.service.AdminUserService;
import com.blog.user.service.GithubAccountService;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.IllegalTransactionStateException;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;

/**
 * Search outbox on a real DB and Meilisearch: every change writes exactly the documents it affects, in the same
 * transaction, merged per document; the worker moves the DB state into the index, retries with backoff, polls tasks
 * already sent. The scheduled worker is off (MeiliIntegrationTest): tests call the bean directly, or build a worker
 * of their own with a fake clock or a dead engine.
 */
class SearchOutboxIT extends MeiliIntegrationTest {

    /** Port 1 of the machine: nothing listens, every call is CONNECTION_FAILED. */
    private static final String DEAD_URL = "http://127.0.0.1:1";

    @Autowired
    private SearchOutbox outbox;

    @Autowired
    private SearchOutboxRepository repository;

    @Autowired
    private SearchOutboxWorker worker;

    @Autowired
    private SearchDocumentSource source;

    @Autowired
    private StaticSearchContent staticContent;

    @Autowired
    private MeiliHttpClient client;

    @Autowired
    private SearchMetrics metrics;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private PostService postService;

    @Autowired
    private CategoryService categoryService;

    @Autowired
    private TagService tagService;

    @Autowired
    private SeriesService seriesService;

    @Autowired
    private AdminUserService adminUserService;

    @Autowired
    private GithubAccountService githubAccountService;

    private final HttpClient http = HttpClient.newHttpClient();

    /** A manually advanced clock for a separately built worker; microseconds like timestamptz. */
    static final class TestClock extends Clock {
        private volatile Instant now;

        TestClock(Instant start) {
            now = start.truncatedTo(ChronoUnit.MICROS);
        }

        void set(Instant instant) {
            now = instant;
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }

    @BeforeEach
    void cleanOutbox() {
        // Delete every outbox row: only ever on the dedicated DB of the Meilisearch ITs.
        assertThat(jdbcTemplate.queryForObject("SELECT current_database()", String.class))
                .isEqualTo("meili_search_it");
        clearOutbox();
        indexer.prepare(INDEX);
    }

    // ------------------------------------------------------------------------------------------------ ghi outbox

    @Test
    void post_changes_write_outbox_in_same_transaction_merged_per_document_and_rollback_leaves_no_row()
            throws Exception {
        String word = uniqueWord();
        Taxon category = createCategory("Section " + word, null);
        Taxon other = createCategory("Other section " + word, null);
        Taxon tag = createTag("Tag " + word);
        Taxon tag2 = createTag("Tag two " + word);
        UUID post = createPost("Post " + word, "noi dung", null, category, tag);
        assertThat(pending()).containsKeys(ref("post", post), ref("category", category.id()), ref("tag", tag.id()));
        clearOutbox();

        // Publish: the post and every document its display depends on; republishing still gives one row per document.
        postService.publish(post, true);
        postService.publish(post, true);
        assertPending(
                ref("post", post), ref("category", category.id()), ref("tag", tag.id()), ref("author", SeedAdmin.ID));
        clearOutbox();

        // Edit the text twice and change the slug: only the post document, one row.
        postService.update(
                post,
                new PostUpdateRequest("Edited " + word, null, "noi dung moi", category.id(), Set.of(tag.id()), null),
                SeedAdmin.ID);
        postService.update(
                post,
                new PostUpdateRequest(
                        "Edited again " + word, null, "noi dung moi", category.id(), Set.of(tag.id()), "slug-" + word),
                SeedAdmin.ID);
        assertThat(slugOf(post)).isEqualTo("slug-" + word);
        assertPending(ref("post", post));
        clearOutbox();
        UUID revision = jdbcTemplate
                .queryForList("SELECT id FROM post_revisions WHERE post_id = ? ORDER BY created_at", UUID.class, post)
                .getFirst();
        postService.restoreRevision(post, revision, SeedAdmin.ID);
        assertPending(ref("post", post));
        clearOutbox();

        // Change the category and tags of a published post: both the old and the new side.
        postService.update(
                post,
                new PostUpdateRequest(
                        "Edited again " + word, null, "noi dung moi", other.id(), Set.of(tag2.id()), null),
                SeedAdmin.ID);
        assertPending(
                ref("post", post),
                ref("category", category.id()),
                ref("category", other.id()),
                ref("tag", tag.id()),
                ref("tag", tag2.id()));
        clearOutbox();

        postService.unpublish(post);
        assertPending(
                ref("post", post), ref("category", other.id()), ref("tag", tag2.id()), ref("author", SeedAdmin.ID));
        clearOutbox();

        // Rollback, explicit or from an error after the write: no row stays.
        TransactionTemplate transaction = new TransactionTemplate(transactionManager);
        transaction.executeWithoutResult(status -> {
            postService.publish(post, true);
            status.setRollbackOnly();
        });
        assertThatThrownBy(() -> transaction.executeWithoutResult(status -> {
                    tagService.update(tag.id(), new TagRequest("Changed " + word));
                    throw new IllegalStateException("broken after the write");
                }))
                .isInstanceOf(IllegalStateException.class);
        assertPending();
        assertThat(jdbcTemplate.queryForObject("SELECT status FROM posts WHERE id = ?", String.class, post))
                .isEqualTo("DRAFT");

        // Delete: the category, tag and author are read BEFORE the delete statement.
        postService.publish(post, true);
        clearOutbox();
        postService.delete(post);
        assertPending(
                ref("post", post), ref("category", other.id()), ref("tag", tag2.id()), ref("author", SeedAdmin.ID));

        // Only inside the transaction of a change, never opens one itself.
        assertThatThrownBy(() -> outbox.enqueue(DocType.POST, post))
                .isInstanceOf(IllegalTransactionStateException.class);
    }

    @Test
    void category_tag_series_user_changes_propagate_to_published_posts_in_one_statement_and_merge_on_repeat()
            throws Exception {
        String word = uniqueWord();
        Taxon category = createCategory("Lan " + word, null);
        Taxon tag = createTag("Lan " + word);
        Taxon target = createTag("Target " + word);
        UUID published = publish("Published " + word, "noi dung", null, category, tag);
        UUID draft = createPost("Draft " + word, "noi dung", null, category, tag);
        Taxon empty = createCategory("Empty " + word, null);
        clearOutbox();

        // Category: the post document carries its name; a draft is not in the index.
        categoryService.update(category.id(), new CategoryRequest("Cascade renamed " + word, "description"));
        categoryService.update(category.id(), new CategoryRequest("Cascade renamed again " + word, null));
        assertPending(ref("category", category.id()), ref("post", published));
        clearOutbox();
        categoryService.delete(empty.id());
        assertPending(ref("category", empty.id()));
        clearOutbox();
        Taxon into = createCategory("Merged into " + word, null);
        clearOutbox();
        categoryService.merge(category.id(), into.id());
        assertPending(ref("post", published), ref("category", category.id()), ref("category", into.id()));
        clearOutbox();

        tagService.update(tag.id(), new TagRequest("Cascade tag renamed " + word));
        assertPending(ref("tag", tag.id()), ref("post", published));
        tagService.merge(tag.id(), target.id());
        assertPending(ref("tag", tag.id()), ref("post", published), ref("tag", target.id()));
        clearOutbox();

        // Series: a published post moves from A to B; A may lose its last published part.
        UUID a = seriesService
                .create(new SeriesRequest("Series A " + word, null, null))
                .id();
        UUID b = seriesService
                .create(new SeriesRequest("Series B " + word, null, null))
                .id();
        assertPending(ref("series", a), ref("series", b));
        seriesService.setPosts(a, List.of(published, draft));
        clearOutbox();
        seriesService.setPosts(b, List.of(published));
        seriesService.setPosts(b, List.of(published));
        assertPending(ref("series", b), ref("post", published), ref("series", a));
        clearOutbox();
        seriesService.update(a, new SeriesRequest("Series A renamed " + word, null, null));
        assertPending(ref("series", a));
        clearOutbox();
        seriesService.delete(b);
        assertPending(ref("series", b), ref("post", published));
        clearOutbox();

        // User: suspend then unsuspend a reader who has a published post.
        User reader = auth.createReader(auth.nextGithubId(), "lan-" + word);
        setAuthor(published, reader.getId());
        adminUserService.setStatus(SeedAdmin.ID, reader.getId(), UserStatus.SUSPENDED);
        adminUserService.setStatus(SeedAdmin.ID, reader.getId(), UserStatus.ACTIVE);
        assertPending(ref("author", reader.getId()), ref("post", published));
        clearOutbox();

        // GitHub login: only when the name changes; the avatar is in no document.
        githubAccountService.recordLogin(new GithubProfile(
                reader.getGithubId(),
                reader.getGithubLogin(),
                reader.getDisplayName(),
                "https://avatars.githubusercontent.com/u/1?v=9"));
        assertPending();
        githubAccountService.recordLogin(new GithubProfile(
                reader.getGithubId(), reader.getGithubLogin(), "New name " + word, reader.getAvatarUrl()));
        assertPending(ref("author", reader.getId()), ref("post", published));
        clearOutbox();
        // A reader with no published post: no document to sync.
        User plain = auth.createReader(auth.nextGithubId(), "chua-viet-" + word);
        githubAccountService.recordLogin(new GithubProfile(
                plain.getGithubId(), plain.getGithubLogin(), "Renamed " + word, plain.getAvatarUrl()));
        assertPending();
    }

    // ------------------------------------------------------------------------------------------------ worker

    @Test
    void worker_writes_newly_published_deletes_unpublished_and_suspended_authors_posts_and_rerun_gives_same_index()
            throws Exception {
        String word = uniqueWord();
        Taxon category = createCategory("Synced " + word, null);
        Taxon tag = createTag("Synced " + word);
        UUID post = publish("Synced " + word, "Body " + word, null, category, tag);
        long syncedBefore = metrics.snapshot().outboxSynced();

        RunSummary first = worker.runOnce();
        assertThat(first.failed()).isZero();
        assertThat(first.synced()).isGreaterThanOrEqualTo(4);
        assertThat(outboxRows()).isZero();
        JsonNode document = document("post-" + post);
        assertThat(document.path("title").asString()).isEqualTo("Synced " + word);
        assertThat(document.path("tagSlugs").get(0).asString()).isEqualTo(tag.slug());
        assertThat(document("category-" + category.id())).isNotNull();
        assertThat(document("tag-" + tag.id())).isNotNull();
        assertThat(document("author-" + SeedAdmin.ID)).isNotNull();
        assertThat(metrics.snapshot().outboxSynced()).isGreaterThanOrEqualTo(syncedBefore + 4);
        // No index rebuild: Meilisearch search already sees the post.
        JsonNode found = search("q", word);
        assertThat(found.path("engine").asString()).isEqualTo("meilisearch");
        assertThat(types(found)).contains("post", "topic");

        // Idempotent: running the same rows twice leaves the index unchanged.
        long documents = client.numberOfDocuments(INDEX);
        for (int i = 0; i < 2; i++) {
            inTransaction(() -> outbox.postAndRelated(post));
            assertThat(worker.runOnce()).isEqualTo(new RunSummary(4, 0));
        }
        assertThat(document("post-" + post)).isEqualTo(document);
        assertThat(client.numberOfDocuments(INDEX)).isEqualTo(documents);

        // Unpublish: the post, category and tag (no published post left) leave the index; rerunning is the same, no
        // error.
        postService.unpublish(post);
        assertThat(worker.runOnce().failed()).isZero();
        assertThat(document("post-" + post)).isNull();
        assertThat(document("category-" + category.id())).isNull();
        assertThat(document("tag-" + tag.id())).isNull();
        inTransaction(() -> outbox.postAndRelated(post));
        assertThat(worker.runOnce()).isEqualTo(new RunSummary(4, 0));
        assertThat(document("post-" + post)).isNull();
        assertThat(client.numberOfDocuments(INDEX)).isEqualTo(documents - 3);

        // Suspend the author: their posts and their profile leave the index.
        User reader = auth.createReader(auth.nextGithubId(), "dong-bo-" + word);
        UUID theirs = publish("Reader's post " + word, "noi dung", null, createCategory("Reader " + word, null));
        setAuthor(theirs, reader.getId());
        inTransaction(() -> outbox.authorAndPublishedPosts(reader.getId()));
        assertThat(worker.runOnce().failed()).isZero();
        assertThat(document("post-" + theirs).path("author").asString()).isEqualTo(reader.getDisplayName());
        assertThat(document("author-" + reader.getId())).isNotNull();
        adminUserService.setStatus(SeedAdmin.ID, reader.getId(), UserStatus.SUSPENDED);
        assertThat(worker.runOnce()).isEqualTo(new RunSummary(2, 0));
        assertThat(document("post-" + theirs)).isNull();
        assertThat(document("author-" + reader.getId())).isNull();

        // Static content by slug: written when it exists, deleted when it no longer does.
        String page = staticContent.pages().getFirst().slug();
        jdbcTemplate.update(
                "INSERT INTO search_outbox (doc_type, source_id, next_attempt_at) VALUES "
                        + "('page', ?, ?), ('page', 'khong-co-trang', ?)",
                page,
                past(),
                past());
        assertThat(worker.runOnce()).isEqualTo(new RunSummary(2, 0));
        assertThat(document("page-" + page)).isNotNull();
        assertThat(document("page-khong-co-trang")).isNull();
    }

    @Test
    void unreachable_engine_retries_with_doubling_backoff_then_failed_new_change_reopens_missing_index_is_not_created()
            throws Exception {
        String word = uniqueWord();
        UUID post = publish("Broken " + word, "noi dung", null, createCategory("Broken " + word, null));
        clearOutbox();
        inTransaction(() -> outbox.enqueue(DocType.POST, post));

        TestClock clock = new TestClock(Instant.now().plusSeconds(1));
        SearchMetrics deadMetrics = new SearchMetrics(clock);
        SearchOutboxWorker dead = worker(properties(DEAD_URL, INDEX), clock, deadMetrics);
        for (int attempt = 1; attempt <= 10; attempt++) {
            assertThat(dead.runOnce()).isEqualTo(new RunSummary(0, 1));
            Map<String, Object> row = row(post);
            assertThat(row.get("attempts")).isEqualTo(attempt);
            assertThat(row.get("last_error_code")).isEqualTo("CONNECTION_FAILED");
            if (attempt == 10) {
                assertThat(row.get("state")).isEqualTo("FAILED");
                break;
            }
            assertThat(row.get("state")).isEqualTo("PENDING");
            Instant next = ((Timestamp) row.get("next_attempt_at")).toInstant();
            assertThat(Duration.between(clock.instant(), next))
                    .isEqualTo(Duration.ofSeconds(Math.min(30L << (attempt - 1), 1800)));
            assertThat(dead.runOnce()).as("not due yet").isEqualTo(new RunSummary(0, 0));
            clock.set(next);
        }
        assertThat(deadMetrics.snapshot().outboxFailed()).isEqualTo(10);
        clock.set(clock.instant().plus(Duration.ofDays(1)));
        assertThat(dead.runOnce()).as("FAILED does not rerun by itself").isEqualTo(new RunSummary(0, 0));

        // A new change reopens the document, and the real engine syncs it.
        inTransaction(() -> outbox.enqueue(DocType.POST, post));
        assertThat(row(post).get("state")).isEqualTo("PENDING");
        assertThat(worker.runOnce()).isEqualTo(new RunSummary(1, 0));
        assertThat(document("post-" + post)).isNotNull();

        // The serving index does not exist: the worker does not create it (it would lack settings), only retries
        // later.
        String absent = "content_it_absent_" + word;
        SearchOutboxWorker noIndex = worker(
                properties(MeiliTestContainer.url(), absent), Clock.systemUTC(), new SearchMetrics(Clock.systemUTC()));
        inTransaction(() -> outbox.enqueue(DocType.POST, post));
        assertThat(noIndex.runOnce()).isEqualTo(new RunSummary(0, 1));
        assertThat(row(post).get("last_error_code")).isEqualTo("INDEX_NOT_FOUND");
        assertThat(client.indexExists(absent)).isFalse();
    }

    @Test
    void row_with_sent_task_polls_that_task_next_time_without_resending_and_failed_task_is_resent_from_db()
            throws Exception {
        String before = uniqueWord();
        String after = uniqueWord();
        UUID post = publish("Before " + before, "noi dung", null, createCategory("Next " + before, null));
        clearOutbox();

        // A worker sent the old version then died before waiting for completion; the post then changes title (not via
        // outbox).
        long task = indexer.submitUpsert(INDEX, source.load(DocType.POST, List.of(post)));
        jdbcTemplate.update("UPDATE posts SET title = ? WHERE id = ?", "Sau " + after, post);
        insertProcessing(post, task);

        // The engine does not answer the task poll: keep PROCESSING and the task, poll again after the backoff.
        TestClock clock = new TestClock(Instant.now().plusSeconds(1));
        SearchOutboxWorker dead = worker(properties(DEAD_URL, INDEX), clock, new SearchMetrics(clock));
        assertThat(dead.runOnce()).isEqualTo(new RunSummary(0, 1));
        assertThat(row(post)).satisfies(row -> {
            assertThat(row.get("state")).isEqualTo("PROCESSING");
            assertThat(row.get("task_uid")).isEqualTo(task);
            assertThat(row.get("attempts")).isEqualTo(1);
            assertThat(((Timestamp) row.get("locked_until")).toInstant())
                    .isEqualTo(clock.instant().plusSeconds(30));
        });

        // Expired: the real worker polls exactly that task and finishes; the index keeps the version sent, no DB
        // write.
        jdbcTemplate.update("UPDATE search_outbox SET locked_until = ? WHERE source_id = ?", past(), post.toString());
        assertThat(worker.runOnce()).isEqualTo(new RunSummary(1, 0));
        assertThat(outboxRows()).isZero();
        assertThat(document("post-" + post).path("title").asString()).isEqualTo("Before " + before);

        // The task failed: the row returns to the queue, the task is dropped; when due it is resent from the DB.
        long failedTask = client.deleteIndex("content_it_missing_" + before);
        insertProcessing(post, failedTask);
        assertThat(worker.runOnce()).isEqualTo(new RunSummary(0, 1));
        assertThat(row(post)).satisfies(row -> {
            assertThat(row.get("state")).isEqualTo("PENDING");
            assertThat(row.get("last_error_code")).isEqualTo("TASK_FAILED");
            assertThat(row.get("task_uid")).isNull();
        });
        jdbcTemplate.update(
                "UPDATE search_outbox SET next_attempt_at = ? WHERE source_id = ?", past(), post.toString());
        assertThat(worker.runOnce()).isEqualTo(new RunSummary(1, 0));
        assertThat(document("post-" + post).path("title").asString()).isEqualTo("Sau " + after);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    private void clearOutbox() {
        jdbcTemplate.update("DELETE FROM search_outbox");
    }

    private int outboxRows() {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM search_outbox", Integer.class);
    }

    private static String ref(String type, UUID id) {
        return type + ":" + id;
    }

    /** {@code type:id} -> number of PENDING rows of that document. */
    private Map<String, Integer> pending() {
        Map<String, Integer> rows = new TreeMap<>();
        jdbcTemplate.query("SELECT doc_type, source_id FROM search_outbox WHERE state = 'PENDING'", rs -> {
            rows.merge(rs.getString("doc_type") + ":" + rs.getString("source_id"), 1, Integer::sum);
        });
        return rows;
    }

    /** Exactly these documents are pending, one row each. */
    private void assertPending(String... refs) {
        assertThat(pending())
                .isEqualTo(Arrays.stream(refs)
                        .distinct()
                        .collect(Collectors.toMap(Function.identity(), ref -> 1, (x, y) -> x, TreeMap::new)));
    }

    private Map<String, Object> row(UUID post) {
        return jdbcTemplate
                .queryForList("SELECT * FROM search_outbox WHERE doc_type = 'post' AND source_id = ?", post.toString())
                .getFirst();
    }

    private void insertProcessing(UUID post, long task) {
        jdbcTemplate.update(
                "INSERT INTO search_outbox (doc_type, source_id, state, next_attempt_at, locked_until, "
                        + "task_uid) VALUES ('post', ?, 'PROCESSING', ?, ?, ?)",
                post.toString(),
                past(),
                past(),
                task);
    }

    /** One minute ago by the JVM clock (the worker's clock), not by the DB's {@code now()}. */
    private static Timestamp past() {
        return Timestamp.from(Instant.now().minusSeconds(60));
    }

    private void inTransaction(Runnable work) {
        new TransactionTemplate(transactionManager).executeWithoutResult(status -> work.run());
    }

    private static SearchProperties properties(String url, String index) {
        return new SearchProperties(
                SearchProperties.Engine.MEILISEARCH,
                new SearchProperties.Meili(
                        url,
                        MeiliTestContainer.MASTER_KEY,
                        index,
                        Duration.ofMillis(300),
                        Duration.ofMillis(800),
                        Duration.ofSeconds(2)));
    }

    private SearchOutboxWorker worker(SearchProperties properties, Clock clock, SearchMetrics workerMetrics) {
        MeiliHttpClient engine = new MeiliHttpClient(properties, objectMapper);
        SearchIndexer writer = new SearchIndexer(engine, new MeiliKeys(engine, properties), source);
        return new SearchOutboxWorker(
                repository, source, staticContent, writer, properties, workerMetrics, transactionManager, clock);
    }

    /** A document in the serving index, read with the master key; null when absent. */
    private JsonNode document(String id) throws Exception {
        HttpResponse<String> response = http.send(
                HttpRequest.newBuilder(URI.create(MeiliTestContainer.url() + "/indexes/" + INDEX + "/documents/" + id))
                        .header("Authorization", "Bearer " + MeiliTestContainer.MASTER_KEY)
                        .GET()
                        .build(),
                HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() == 404) {
            return null;
        }
        assertThat(response.statusCode()).as(response.body()).isEqualTo(200);
        return objectMapper.readTree(response.body());
    }
}
