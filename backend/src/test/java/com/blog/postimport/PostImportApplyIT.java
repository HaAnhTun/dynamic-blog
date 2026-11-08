package com.blog.postimport;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.reset;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.category.dto.CategoryRequest;
import com.blog.category.service.CategoryService;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.post.dto.PostCreateRequest;
import com.blog.post.repository.PostRepository;
import com.blog.post.service.PostService;
import com.blog.postimport.format.PostFile;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.HeldTransaction;
import com.blog.support.LogAssertions;
import com.blog.tag.dto.TagRequest;
import com.blog.tag.service.TagService;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockMultipartHttpServletRequestBuilder;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The apply and the status of the post import through the HTTP API, with the real filter chain and a real database: the
 * journey from the preview to the drafts, what an apply refuses and why, that it writes all or nothing, that a stale preview
 * is refused, the locks, who may call it and that no answer and no log line holds text of a file.
 *
 * Every test has its own accounts (the rate limit is per person) and puts a random token into every slug and name: the
 * database is shared and never cleaned.
 */
@AutoConfigureMockMvc
class PostImportApplyIT extends AbstractIntegrationTest {

    private static final String BASE = "/api/v1/admin/post-import";
    private static final String BODY = "A short body for the import apply.\n";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @MockitoSpyBean
    private CategoryService categoryService;

    @MockitoSpyBean
    private TagService tagService;

    @MockitoSpyBean
    private PostService postService;

    private User authorUser;
    private String admin;
    private String author;
    private String otherAuthor;
    private String reader;
    private String token;

    @BeforeEach
    void setUp() {
        token = UUID.randomUUID().toString().substring(0, 8);
        admin = auth.bearerFor(auth.createAccount("post-apply-admin-" + token + "@blog.local", UserRole.ADMIN));
        authorUser = auth.createAuthor("post-apply-author-" + token + "@blog.local");
        author = auth.bearerFor(authorUser);
        otherAuthor = auth.bearerFor(auth.createAuthor("post-apply-other-" + token + "@blog.local"));
        reader = auth.bearerFor(auth.createReader(auth.nextGithubId(), "post-apply-reader-" + token));
    }

    @AfterEach
    void resetSpies() {
        reset(categoryService, tagService, postService);
    }

    // --- The journey ----------------------------------------------------------------------------------------

    @Test
    void a_previewed_file_becomes_a_draft_of_the_caller_with_its_new_category_and_tags_and_a_log_row()
            throws Exception {
        String text = file(
                "title: Applied " + token,
                "slug: applied-" + token,
                "excerpt: One sentence.",
                "category: Applied category " + token,
                "tags: first-" + token + ", second-" + token);
        MockMultipartFile upload = markdown("applied.md", text);
        long newslettersBefore = count("newsletter_issues");

        JsonNode preview = preview(author, upload);
        JsonNode applied = data(apply(author, manifest(preview, true), upload).andExpect(status().isOk()));

        assertThat(applied.path("created").asInt()).isEqualTo(1);
        assertThat(applied.path("skipped").asInt()).isZero();
        JsonNode file = applied.path("files").get(0);
        assertThat(file.path("result").asString()).isEqualTo("created");
        assertThat(file.path("slug").asString()).isEqualTo("applied-" + token);
        UUID postId = UUID.fromString(file.path("postId").asString());
        Map<String, Object> row = jdbcTemplate.queryForMap(
                "select status, author_id, language, excerpt, published_at from posts where id = ?", postId);
        assertThat(row.get("status")).isEqualTo("DRAFT");
        assertThat(row.get("author_id")).isEqualTo(authorUser.getId());
        assertThat(row.get("published_at")).isNull();
        assertThat(row.get("excerpt")).isEqualTo("One sentence.");
        assertThat(jdbcTemplate.queryForObject(
                        "select c.name from posts p join categories c on c.id = p.category_id where p.id = ?",
                        String.class,
                        postId))
                .isEqualTo("Applied category " + token);
        assertThat(jdbcTemplate.queryForList(
                        "select t.name from post_tags pt join tags t on t.id = pt.tag_id where pt.post_id = ? order by t.name",
                        String.class,
                        postId))
                .containsExactly("first-" + token, "second-" + token);

        // A draft is in no public answer and nothing is queued for subscribers. (The search outbox is switched off in
        // this
        // context, so its rows cannot be observed here; the post service writes them, as for the editor.)
        mockMvc.perform(get("/api/v1/posts/applied-" + token)).andExpect(status().isNotFound());
        assertThat(responseBody(mockMvc.perform(get("/api/v1/posts").param("size", "50"))))
                .doesNotContain("applied-" + token);
        assertThat(responseBody(mockMvc.perform(get("/api/v1/posts/search").param("q", "Applied " + token))))
                .doesNotContain("applied-" + token);
        // A category and a tag that only a draft uses are not public either.
        assertThat(responseBody(mockMvc.perform(get("/api/v1/categories")))).doesNotContain(token);
        assertThat(responseBody(mockMvc.perform(get("/api/v1/tags")))).doesNotContain(token);
        assertThat(count("newsletter_issues")).isEqualTo(newslettersBefore);

        // The log row holds ids, hashes and counts, and its hash is the one of the preview's file.
        long importId = applied.path("importId").asLong();
        Map<String, Object> log = jdbcTemplate.queryForMap(
                "select created_by, file_count, file_bytes, cast(file_hashes as text) as hashes, cast(items as text) as items,"
                        + " undone_at from post_import_log where id = ?",
                importId);
        assertThat(log.get("created_by")).isEqualTo(authorUser.getId());
        assertThat(log.get("file_count")).isEqualTo(1);
        assertThat(log.get("file_bytes")).isEqualTo(text.getBytes(UTF_8).length);
        assertThat(log.get("undone_at")).isNull();
        assertThat((String) log.get("hashes")).contains(PostFile.sha256Hex(text.getBytes(UTF_8)));
        JsonNode item = objectMapper.readTree((String) log.get("items")).get(0);
        assertThat(item.path("action").asString()).isEqualTo("created");
        assertThat(item.path("postId").asString()).isEqualTo(postId.toString());
        assertThat(item.path("previousRevisionId").isNull()).isTrue();
        assertThat(item.path("previousCategoryId").isNull()).isTrue();
        assertThat(item.path("previousTagIds").size()).isZero();
        assertThat(item.path("afterHash").asString()).matches("[0-9a-f]{64}");
        assertThat(item.path("linkCreated").asBoolean()).isFalse();
        assertThat(log.get("items").toString()).doesNotContain(token);
        assertThat(log.get("hashes").toString()).doesNotContain(token);
    }

    @Test
    void a_new_post_is_a_draft_of_the_caller_whatever_the_file_says_about_status_featured_or_author() throws Exception {
        MockMultipartFile upload = markdown(
                "forged.md",
                file(
                        "title: Forged " + token,
                        "slug: forged-" + token,
                        "status: published",
                        "featured: true",
                        "author: forged-" + token,
                        "author_id: 1"));

        JsonNode preview = preview(author, upload);
        JsonNode applied = data(apply(author, manifest(preview, true), upload).andExpect(status().isOk()));

        assertThat(preview.path("files").get(0).path("state").asString()).isEqualTo("new");
        UUID postId =
                UUID.fromString(applied.path("files").get(0).path("postId").asString());
        Map<String, Object> row = jdbcTemplate.queryForMap(
                "select status, featured, author_id, published_at from posts where id = ?", postId);
        assertThat(row.get("status")).isEqualTo("DRAFT");
        assertThat(row.get("featured")).isEqualTo(false);
        assertThat(row.get("author_id")).isEqualTo(authorUser.getId());
        assertThat(row.get("published_at")).isNull();
        mockMvc.perform(get("/api/v1/posts/forged-" + token)).andExpect(status().isNotFound());
    }

    @Test
    void the_status_is_the_callers_own_latest_import() throws Exception {
        assertThat(data(statusCall(author)).path("lastImport").isNull()).isTrue();
        MockMultipartFile upload = markdown("one.md", file("title: Status " + token, "slug: status-" + token));
        long importId = data(apply(author, manifest(preview(author, upload), true), upload)
                        .andExpect(status().isOk()))
                .path("importId")
                .asLong();

        JsonNode last = data(statusCall(author)).path("lastImport");

        assertThat(last.path("id").asLong()).isEqualTo(importId);
        assertThat(last.path("files").asInt()).isEqualTo(1);
        assertThat(last.path("created").asInt()).isEqualTo(1);
        assertThat(last.path("updated").asInt()).isZero();
        assertThat(last.path("undone").asBoolean()).isFalse();
        assertThat(last.path("undoable").asBoolean()).isFalse();
        assertThat(last.path("createdAt").asString()).isNotEmpty();
        // Nobody else sees it.
        assertThat(data(statusCall(otherAuthor)).path("lastImport").isNull()).isTrue();
        assertThat(data(statusCall(admin)).path("lastImport").isNull()).isTrue();
    }

    @Test
    void an_unselected_file_is_skipped_and_nothing_of_it_is_written() throws Exception {
        MockMultipartFile first = markdown("a.md", file("title: First " + token, "slug: first-" + token));
        MockMultipartFile second = markdown("b.md", file("title: Second " + token, "slug: second-" + token));
        JsonNode preview = preview(author, first, second);

        JsonNode applied = data(
                apply(author, manifest(preview, true, false), first, second).andExpect(status().isOk()));

        assertThat(applied.path("created").asInt()).isEqualTo(1);
        assertThat(applied.path("skipped").asInt()).isEqualTo(1);
        assertThat(applied.path("files").get(0).path("result").asString()).isEqualTo("created");
        assertThat(applied.path("files").get(1).path("result").asString()).isEqualTo("skipped");
        assertThat(applied.path("files").get(1).path("postId").isNull()).isTrue();
        assertThat(postCount("first-" + token)).isEqualTo(1);
        assertThat(postCount("second-" + token)).isZero();
    }

    @Test
    void a_second_apply_of_the_same_preview_creates_no_second_post_and_writes_nothing() throws Exception {
        MockMultipartFile upload = markdown("twice.md", file("title: Twice " + token, "slug: twice-" + token));
        String manifest = manifest(preview(author, upload), true);
        apply(author, manifest, upload).andExpect(status().isOk());
        Snapshot before = snapshot();

        JsonNode again = data(apply(author, manifest, upload).andExpect(status().isOk()));

        // The post is there and the file says nothing new: it is reported as unchanged, not made again.
        assertThat(again.path("created").asInt()).isZero();
        assertThat(again.path("unchanged").asInt()).isEqualTo(1);
        assertThat(again.path("importId").isNull()).isTrue();
        assertThat(postCount("twice-" + token)).isEqualTo(1);
        assertThat(postCount("twice-" + token + "-2")).isZero();
        assertThat(snapshot()).isEqualTo(before);
    }

    // --- Refusals that write nothing ------------------------------------------------------------------------

    @Test
    void a_file_that_is_not_the_previewed_one_is_refused_and_nothing_is_written() throws Exception {
        MockMultipartFile previewed = markdown("a.md", file("title: Before " + token, "slug: swap-" + token));
        String manifest = manifest(preview(author, previewed), true);
        MockMultipartFile changed = markdown("a.md", file("title: After " + token, "slug: swap-" + token));
        Snapshot before = snapshot();

        ResultActions result = apply(author, manifest, changed);

        assertError(result, 409, "POST_IMPORT_HASH_MISMATCH");
        assertThat(snapshot()).isEqualTo(before);
    }

    @Test
    void a_missing_or_malformed_manifest_is_refused_and_nothing_is_written() throws Exception {
        MockMultipartFile upload = markdown("m.md", file("title: Manifest " + token, "slug: manifest-" + token));
        String sha = PostFile.sha256Hex(upload.getBytes());
        Snapshot before = snapshot();

        assertError(apply(author, null, upload), 400, "POST_IMPORT_INVALID_FILE");
        assertError(apply(author, "", upload), 400, "POST_IMPORT_INVALID_FILE");
        assertError(apply(author, "not json", upload), 400, "POST_IMPORT_INVALID_FILE");
        assertError(apply(author, "{}", upload), 400, "POST_IMPORT_INVALID_FILE");
        assertError(apply(author, "[]", upload), 400, "POST_IMPORT_INVALID_FILE");
        assertError(apply(author, "[1]", upload), 400, "POST_IMPORT_INVALID_FILE");
        assertError(apply(author, "[{\"sha256\":\"zz\",\"selected\":true}]", upload), 400, "POST_IMPORT_INVALID_FILE");
        assertError(apply(author, "[{\"sha256\":\"" + sha + "\"}]", upload), 400, "POST_IMPORT_INVALID_FILE");
        assertError(
                apply(author, "[{\"sha256\":\"" + sha + "\",\"selected\":true,\"state\":5}]", upload),
                400,
                "POST_IMPORT_INVALID_FILE");
        assertError(
                apply(author, "[{\"sha256\":\"" + sha + "\",\"selected\":false}]", upload),
                400,
                "POST_IMPORT_INVALID_FILE");
        assertError(
                apply(author, "[{\"sha256\":\"" + sha + "\",\"selected\":true},{\"sha256\":\"" + sha + "\"}]", upload),
                400,
                "POST_IMPORT_INVALID_FILE");
        assertError(apply(author, manifestOf(sha, true, null)), 400, "POST_IMPORT_INVALID_FILE");
        assertThat(snapshot()).isEqualTo(before);
    }

    @Test
    void a_selected_file_with_a_problem_rejects_the_whole_apply_and_lists_the_problems_by_position() throws Exception {
        MockMultipartFile good = markdown("good.md", file("title: Good " + token, "slug: good-" + token));
        MockMultipartFile bad = markdown("bad.md", file("title: Bad " + token, "slug: bad-" + token, "language: zz"));
        JsonNode preview = preview(author, good, bad);
        assertThat(preview.path("files").get(1).path("state").asString()).isEqualTo("error");
        Snapshot before = snapshot();

        ResultActions result = apply(author, manifest(preview, true, true), good, bad);

        assertError(result, 400, "POST_IMPORT_INVALID");
        assertThat(message(result)).startsWith("File 2 ").contains("language").doesNotContain(token);
        assertThat(snapshot()).isEqualTo(before);
        assertThat(postCount("good-" + token)).isZero();
        // Unticked, the same file does not stop the good one.
        apply(author, manifest(preview, true, false), good, bad).andExpect(status().isOk());
        assertThat(postCount("good-" + token)).isEqualTo(1);
    }

    @Test
    void two_selected_files_with_the_same_slug_are_a_problem_of_both_and_write_nothing() throws Exception {
        MockMultipartFile first = markdown("a.md", file("title: One " + token, "slug: same-" + token));
        MockMultipartFile second = markdown("b.md", file("title: Two " + token, "slug: same-" + token));
        JsonNode preview = preview(author, first, second);
        Snapshot before = snapshot();

        ResultActions result = apply(author, manifest(preview, true, true), first, second);

        assertError(result, 400, "POST_IMPORT_INVALID");
        assertThat(message(result)).contains("File 1").contains("File 2");
        assertThat(snapshot()).isEqualTo(before);
    }

    // --- The preview is out of date -------------------------------------------------------------------------

    @Test
    void a_slug_taken_between_the_preview_and_the_apply_is_a_conflict_with_a_count_only() throws Exception {
        MockMultipartFile upload = markdown("race.md", file("title: Race " + token, "slug: race-" + token));
        String manifest = manifest(preview(author, upload), true);
        createPost(otherAuthor, "Taken " + token, "race-" + token);
        Snapshot before = snapshot();

        ResultActions result = apply(author, manifest, upload);

        assertError(result, 409, "POST_IMPORT_PREVIEW_OUT_OF_DATE");
        assertThat(message(result)).isEqualTo("1 file is no longer as previewed; preview again");
        assertThat(snapshot()).isEqualTo(before);
    }

    @Test
    void a_selected_file_without_a_preview_state_that_would_be_written_now_is_a_conflict_never_a_silent_write()
            throws Exception {
        MockMultipartFile upload = markdown("nostate.md", file("title: Silent " + token, "slug: silent-" + token));
        String sha = PostFile.sha256Hex(upload.getBytes());
        Snapshot before = snapshot();

        assertError(apply(author, manifestOf(sha, true, null), upload), 409, "POST_IMPORT_PREVIEW_OUT_OF_DATE");
        assertError(apply(author, manifestOf(sha, true, "forged"), upload), 409, "POST_IMPORT_PREVIEW_OUT_OF_DATE");

        assertThat(snapshot()).isEqualTo(before);
    }

    @Test
    void an_unselected_file_is_not_compared_with_its_preview() throws Exception {
        MockMultipartFile first = markdown("a.md", file("title: Kept " + token, "slug: kept-" + token));
        MockMultipartFile second = markdown("b.md", file("title: Late " + token, "slug: late-" + token));
        JsonNode preview = preview(author, first, second);
        createPost(otherAuthor, "Taken " + token, "late-" + token);

        apply(author, manifest(preview, true, false), first, second).andExpect(status().isOk());

        assertThat(postCount("kept-" + token)).isEqualTo(1);
    }

    @Test
    void a_category_or_tag_name_that_appears_during_the_apply_is_a_conflict_by_position_and_nothing_is_written()
            throws Exception {
        MockMultipartFile first = markdown("a.md", file("title: One " + token, "slug: race-one-" + token));
        MockMultipartFile second = markdown(
                "b.md", file("title: Two " + token, "slug: race-two-" + token, "category: Raced category " + token));
        JsonNode preview = preview(author, first, second);
        String manifest = manifest(preview, true, true);
        doThrow(new ApiException(ErrorCode.CATEGORY_ALREADY_EXISTS, org.springframework.http.HttpStatus.CONFLICT, "x"))
                .when(categoryService)
                .create(any(CategoryRequest.class));
        Snapshot before = snapshot();

        ResultActions result = apply(author, manifest, first, second);

        assertError(result, 409, "POST_IMPORT_PREVIEW_OUT_OF_DATE");
        assertThat(message(result)).startsWith("File 2 ").doesNotContain(token);
        // The first post was made and flushed before the second file failed: all of it is rolled back.
        assertThat(snapshot()).isEqualTo(before);
        assertThat(postCount("race-one-" + token)).isZero();

        reset(categoryService);
        MockMultipartFile tagged = markdown(
                "c.md", file("title: Three " + token, "slug: race-three-" + token, "tags: raced-tag-" + token));
        String taggedManifest = manifest(preview(author, tagged), true);
        doThrow(new ApiException(ErrorCode.TAG_ALREADY_EXISTS, org.springframework.http.HttpStatus.CONFLICT, "x"))
                .when(tagService)
                .create(any(TagRequest.class));
        assertError(apply(author, taggedManifest, tagged), 409, "POST_IMPORT_PREVIEW_OUT_OF_DATE");
        assertThat(postCount("race-three-" + token)).isZero();
    }

    @Test
    void a_slug_that_the_post_service_had_to_number_rolls_the_whole_apply_back_as_slug_not_available()
            throws Exception {
        MockMultipartFile first = markdown("a.md", file("title: One " + token, "slug: numbered-one-" + token));
        MockMultipartFile second = markdown("b.md", file("title: Two " + token, "slug: numbered-two-" + token));
        String manifest = manifest(preview(author, first, second), true, true);
        Snapshot before = snapshot();
        // Another writer takes the planned slug of the second file after the plan and before the file is created.
        AtomicBoolean taken = new AtomicBoolean();
        doAnswer(invocation -> {
                    PostCreateRequest request = invocation.getArgument(1);
                    if (("numbered-two-" + token).equals(request.slug()) && taken.compareAndSet(false, true)) {
                        CompletableFuture.runAsync(() -> {
                                    try {
                                        createPost(otherAuthor, "Taken " + token, "numbered-two-" + token);
                                    } catch (Exception e) {
                                        throw new IllegalStateException(e);
                                    }
                                })
                                .get(30, TimeUnit.SECONDS);
                    }
                    return invocation.callRealMethod();
                })
                .when(postService)
                .create(any(UUID.class), any(PostCreateRequest.class));

        ResultActions result = apply(author, manifest, first, second);

        assertError(result, 400, "POST_IMPORT_INVALID");
        assertThat(message(result)).isEqualTo("File 2 slug: this slug is not available; choose another slug");
        assertThat(postCount("numbered-one-" + token)).isZero();
        assertThat(postCount("numbered-two-" + token + "-2")).isZero();
        assertThat(postCount("numbered-two-" + token)).isEqualTo(1);
        assertThat(count("post_import_log"))
                .isEqualTo(before.counts().get("post_import_log").longValue());
    }

    @Test
    void a_unique_constraint_violation_of_the_post_is_slug_not_available_without_any_detail() throws Exception {
        MockMultipartFile upload = markdown("u.md", file("title: Unique " + token, "slug: unique-" + token));
        String manifest = manifest(preview(author, upload), true);
        Snapshot before = snapshot();
        doThrow(new DataIntegrityViolationException("duplicate key value violates posts_slug_key " + token))
                .when(postService)
                .create(any(UUID.class), any(PostCreateRequest.class));

        ResultActions result = apply(author, manifest, upload);

        assertError(result, 400, "POST_IMPORT_INVALID");
        assertThat(message(result)).isEqualTo("File 1 slug: this slug is not available; choose another slug");
        assertThat(responseBody(result)).doesNotContain(token, "posts_slug_key");
        assertThat(snapshot()).isEqualTo(before);
    }

    // --- All or nothing -------------------------------------------------------------------------------------

    @Test
    void an_unexpected_failure_part_way_through_the_writes_leaves_every_table_as_it_was_and_answers_the_generic_error()
            throws Exception {
        MockMultipartFile first =
                markdown("a.md", file("title: One " + token, "slug: atomic-one-" + token, "category: Atomic " + token));
        MockMultipartFile second =
                markdown("b.md", file("title: Two " + token, "slug: atomic-two-" + token, "tags: atomic-tag-" + token));
        String manifest = manifest(preview(author, first, second), true, true);
        Snapshot before = snapshot();
        // The first post and its category are written and flushed; the second file then fails in the tag service.
        doThrow(new DataAccessResourceFailureException("simulated failure " + token))
                .when(tagService)
                .create(any(TagRequest.class));

        ResultActions result = apply(author, manifest, first, second);

        // Not a failure the import knows: the handler of last resort answers, with its code and nothing else.
        assertError(result, 500, "INTERNAL_ERROR");
        assertThat(responseBody(result)).doesNotContain(token);
        assertThat(snapshot()).isEqualTo(before);
        assertThat(postCount("atomic-one-" + token)).isZero();
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from categories where name = ?", Integer.class, "Atomic " + token))
                .isZero();
    }

    @Test
    void a_data_integrity_failure_at_the_category_or_tag_write_is_the_import_conflict_of_that_file_and_rolls_back()
            throws Exception {
        MockMultipartFile first =
                markdown("a.md", file("title: One " + token, "slug: mapped-one-" + token, "category: Mapped " + token));
        MockMultipartFile second =
                markdown("b.md", file("title: Two " + token, "slug: mapped-two-" + token, "tags: mapped-tag-" + token));
        String manifest = manifest(preview(author, first, second), true, true);
        Snapshot before = snapshot();
        // File 1 is written and flushed (post and category); file 2 then fails at its tag.
        doThrow(new DataIntegrityViolationException("duplicate key value violates tags_name_key " + token))
                .when(tagService)
                .create(any(TagRequest.class));

        ResultActions atTag = apply(author, manifest, first, second);

        assertError(atTag, 409, "POST_IMPORT_PREVIEW_OUT_OF_DATE");
        assertThat(message(atTag)).isEqualTo("File 2 could not be written because the data changed; preview again");
        assertThat(responseBody(atTag)).doesNotContain(token, "tags_name_key");
        assertThat(snapshot()).isEqualTo(before);

        reset(tagService);
        doThrow(new DataIntegrityViolationException("duplicate key value violates categories_name_key " + token))
                .when(categoryService)
                .create(any(CategoryRequest.class));

        ResultActions atCategory = apply(author, manifest, first, second);

        assertError(atCategory, 409, "POST_IMPORT_PREVIEW_OUT_OF_DATE");
        assertThat(message(atCategory))
                .isEqualTo("File 1 could not be written because the data changed; preview again");
        assertThat(responseBody(atCategory)).doesNotContain(token, "categories_name_key");
        assertThat(snapshot()).isEqualTo(before);
        assertThat(postCount("mapped-one-" + token)).isZero();
    }

    // --- Concurrency and locks ------------------------------------------------------------------------------

    @Test
    void two_simultaneous_applies_of_the_same_file_make_one_post_and_the_other_finds_it_unchanged() throws Exception {
        MockMultipartFile upload = markdown("same.md", file("title: Same " + token, "slug: parallel-" + token));
        String manifest = manifest(preview(author, upload), true);
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        List<JsonNode> answers = new ArrayList<>();
        try {
            List<Future<JsonNode>> results = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                Callable<JsonNode> run = () -> {
                    start.await();
                    return data(apply(author, manifest, upload).andExpect(status().isOk()));
                };
                results.add(pool.submit(run));
            }
            start.countDown();
            for (Future<JsonNode> result : results) {
                answers.add(result.get(60, TimeUnit.SECONDS));
            }
        } finally {
            pool.shutdownNow();
        }

        // The apply that comes second reads the post the first one made, under the import lock, and writes nothing.
        assertThat(answers.stream()
                        .mapToInt(answer -> answer.path("created").asInt())
                        .sum())
                .isEqualTo(1);
        assertThat(answers.stream()
                        .mapToInt(answer -> answer.path("unchanged").asInt())
                        .sum())
                .isEqualTo(1);
        assertThat(postCount("parallel-" + token)).isEqualTo(1);
        assertThat(postCount("parallel-" + token + "-2")).isZero();
    }

    @Test
    void an_apply_waits_for_the_translation_writes_lock_and_finishes_when_it_is_released_without_a_deadlock()
            throws Exception {
        MockMultipartFile upload = markdown("lock.md", file("title: Lock " + token, "slug: lock-" + token));
        String manifest = manifest(preview(author, upload), true);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try (HeldTransaction held = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForObject(
                        "select 1 from pg_advisory_xact_lock(" + PostRepository.TRANSLATION_LOCK_KEY + ")",
                        Integer.class))) {
            Future<Integer> running = pool.submit(() ->
                    apply(author, manifest, upload).andReturn().getResponse().getStatus());
            // The apply waits at one of its two advisory locks (the fragment matches both: the order of the two is
            // pinned by
            // the next tests) and has written nothing.
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "pg_advisory_xact_lock", 1);
            assertThat(running.isDone()).isFalse();
            assertThat(postCount("lock-" + token)).isZero();

            held.commit();

            assertThat(running.get(60, TimeUnit.SECONDS)).isEqualTo(200);
        } finally {
            pool.shutdownNow();
        }
        assertThat(postCount("lock-" + token)).isEqualTo(1);
    }

    @Test
    void an_apply_holds_the_translation_writes_lock_while_it_waits_for_the_import_wide_lock() throws Exception {
        MockMultipartFile upload = markdown("order.md", file("title: Order " + token, "slug: order-" + token));
        String manifest = manifest(preview(author, upload), true);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try (HeldTransaction held = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForObject(
                        "select 1 from pg_advisory_xact_lock(hashtextextended('post-import', 0))", Integer.class))) {
            Future<Integer> running = pool.submit(() ->
                    apply(author, manifest, upload).andReturn().getResponse().getStatus());
            // Stopped at the import-wide lock: the one that comes second.
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "hashtextextended", 1);

            // So the translation writes lock, which comes first, is already the apply's: no other session can take it.
            assertThat(jdbcTemplate.queryForObject(
                            "select pg_try_advisory_xact_lock(" + PostRepository.TRANSLATION_LOCK_KEY + ")",
                            Boolean.class))
                    .isFalse();
            assertThat(running.isDone()).isFalse();
            assertThat(postCount("order-" + token)).isZero();

            held.commit();

            assertThat(running.get(60, TimeUnit.SECONDS)).isEqualTo(200);
        } finally {
            pool.shutdownNow();
        }
        assertThat(postCount("order-" + token)).isEqualTo(1);
    }

    @Test
    void the_plan_is_read_after_the_locks_so_a_post_made_while_the_apply_waits_is_a_conflict_and_nothing_is_written()
            throws Exception {
        MockMultipartFile upload = markdown("late.md", file("title: Late " + token, "slug: late-" + token));
        String manifest = manifest(preview(author, upload), true);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        ResultActions result;
        Snapshot before;
        try (HeldTransaction held = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForObject(
                        "select 1 from pg_advisory_xact_lock(" + PostRepository.TRANSLATION_LOCK_KEY + ")",
                        Integer.class))) {
            Future<ResultActions> running = pool.submit(() -> apply(author, manifest, upload));
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "pg_advisory_xact_lock", 1);
            // The slug was free when the preview ran; another writer takes it while the apply waits for its locks.
            createPost(otherAuthor, "Late " + token, "late-" + token);
            before = snapshot();

            held.commit();

            result = running.get(60, TimeUnit.SECONDS);
        } finally {
            pool.shutdownNow();
        }

        // Read before the locks, the plan would still say "new" and the apply would number the slug or fail at the
        // write.
        assertError(result, 409, "POST_IMPORT_PREVIEW_OUT_OF_DATE");
        assertThat(message(result)).isEqualTo("1 file is no longer as previewed; preview again");
        assertThat(snapshot()).isEqualTo(before);
        assertThat(postCount("late-" + token)).isEqualTo(1);
        assertThat(postCount("late-" + token + "-2")).isZero();
    }

    // --- Who may apply --------------------------------------------------------------------------------------

    @Test
    void an_author_can_apply_and_a_reader_or_a_visitor_is_refused_with_nothing_written() throws Exception {
        MockMultipartFile upload = markdown("roles.md", file("title: Roles " + token, "slug: roles-" + token));
        String manifest = manifest(preview(author, upload), true);
        Snapshot before = snapshot();

        assertError(apply(reader, manifest, upload), 403, "FORBIDDEN");
        assertError(apply(null, manifest, upload), 401, "UNAUTHENTICATED");
        assertError(statusCall(reader), 403, "FORBIDDEN");
        assertError(statusCall(null), 401, "UNAUTHENTICATED");
        assertThat(snapshot()).isEqualTo(before);

        apply(author, manifest, upload).andExpect(status().isOk());
        assertThat(jdbcTemplate.queryForObject(
                        "select author_id from posts where slug = ?", UUID.class, "roles-" + token))
                .isEqualTo(authorUser.getId());
    }

    @Test
    void an_admin_applies_new_drafts_owned_by_the_admin() throws Exception {
        MockMultipartFile upload = markdown("admin.md", file("title: Admin " + token, "slug: admin-" + token));

        apply(admin, manifest(preview(admin, upload), true), upload).andExpect(status().isOk());

        assertThat(jdbcTemplate.queryForObject(
                        "select u.email from posts p join users u on u.id = p.author_id where p.slug = ?",
                        String.class,
                        "admin-" + token))
                .isEqualTo("post-apply-admin-" + token + "@blog.local");
        assertThat(jdbcTemplate.queryForObject(
                        "select status from posts where slug = ?", String.class, "admin-" + token))
                .isEqualTo("DRAFT");
    }

    @Test
    void applies_count_against_the_post_import_limit() throws Exception {
        String limited = auth.bearerFor(auth.createAuthor("post-apply-limit-" + token + "@blog.local"));
        int status = 400;
        int calls = 0;
        // Without a file part the apply is refused after it was counted, so this writes nothing.
        while (status != 429 && calls < 200) {
            status = apply(limited, null).andReturn().getResponse().getStatus();
            calls++;
        }

        assertThat(calls).isGreaterThan(1);
        assertThat(status).isEqualTo(429);
    }

    // --- Hygiene --------------------------------------------------------------------------------------------

    @Test
    void no_log_line_answer_or_log_row_holds_a_value_of_the_files_when_applying_or_failing() throws Exception {
        String marker = "Quokka-Marker-" + token;
        String lower = marker.toLowerCase(Locale.ROOT);
        String text = file(
                "A body line with " + marker + "\n",
                "title: Title " + marker,
                "slug: slug-" + lower,
                "excerpt: Excerpt " + marker,
                "category: Category " + marker,
                "tags: Tag " + marker + ", other " + marker,
                "status: published",
                "key with " + marker + ": value");
        MockMultipartFile upload = markdown("name-" + marker + ".md", text);
        MockMultipartFile bad =
                markdown("bad-" + marker + ".md", file("title: Bad " + marker, "language: zz-" + marker));
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        Logger imports = (Logger) LoggerFactory.getLogger("com.blog.postimport");
        Level previous = imports.getLevel();
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        imports.setLevel(Level.DEBUG);
        List<String> bodies = new ArrayList<>();
        try {
            String manifest = manifest(preview(author, upload), true);
            // A stale preview, a changed file, a bad manifest, a problem file, a failed write, then the success.
            createPost(otherAuthor, "Taken " + marker, "slug-" + lower);
            bodies.add(responseBody(apply(author, manifest, upload)));
            bodies.add(responseBody(apply(author, manifest, markdown("name-" + marker + ".md", text + "x"))));
            bodies.add(responseBody(apply(author, "not json " + marker, upload)));
            bodies.add(responseBody(apply(author, manifestOf(PostFile.sha256Hex(bad.getBytes()), true, null), bad)));
            // A control character in a body line: the refusal names the line (the sixth), never the text around it.
            MockMultipartFile control = markdown(
                    "control-" + marker + ".md",
                    "---\ntitle: Title " + marker + "\n---\n\nFirst body line\nSecond " + marker + "\u0001 line\n");
            String controlAnswer = responseBody(
                    apply(author, manifestOf(PostFile.sha256Hex(control.getBytes()), true, null), control));
            assertThat(controlAnswer).contains("control character on line 6");
            bodies.add(controlAnswer);
            MockMultipartFile fresh =
                    markdown("fresh-" + marker + ".md", text.replace("slug-" + lower, "fresh-" + lower));
            String freshManifest = manifest(preview(author, fresh), true);
            doThrow(new ApiException(
                            ErrorCode.CATEGORY_ALREADY_EXISTS, org.springframework.http.HttpStatus.CONFLICT, marker))
                    .when(categoryService)
                    .create(any(CategoryRequest.class));
            bodies.add(responseBody(apply(author, freshManifest, fresh)));
            reset(categoryService);
            ResultActions success = apply(author, freshManifest, fresh);
            bodies.add(responseBody(success.andExpect(status().isOk())));
        } finally {
            root.detachAppender(logs);
            imports.setLevel(previous);
        }

        assertThat(logs.list)
                .anySatisfy(event -> assertThat(event.getFormattedMessage()).startsWith("post import applied"));
        LogAssertions.assertNoValues(logs.list, marker, lower);
        // Every error answer is free of the values; the success answer may name the caller's own file and slug.
        for (String body : bodies.subList(0, bodies.size() - 1)) {
            assertThat(body).isNotEmpty().doesNotContain(marker, lower);
        }
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from post_import_log where cast(items as text) ilike ? or cast(file_hashes as text) ilike ?",
                        Integer.class,
                        "%" + marker + "%",
                        "%" + marker + "%"))
                .isZero();
    }

    // --- Helpers --------------------------------------------------------------------------------------------

    /** A row count of every table an apply that writes nothing must not touch. */
    private record Snapshot(Map<String, Integer> counts) {}

    private Snapshot snapshot() {
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (String table : List.of(
                "posts",
                "categories",
                "tags",
                "post_tags",
                "post_revisions",
                "post_slug_history",
                "search_outbox",
                "newsletter_issues",
                "post_import_log")) {
            counts.put(table, jdbcTemplate.queryForObject("select count(*) from " + table, Integer.class));
        }
        return new Snapshot(counts);
    }

    private long count(String table) {
        return jdbcTemplate.queryForObject("select count(*) from " + table, Long.class);
    }

    private int postCount(String slug) {
        return jdbcTemplate.queryForObject("select count(*) from posts where slug = ?", Integer.class, slug);
    }

    /** A post file: the front matter lines, then a body; a first argument that ends with a line break is the body. */
    private static String file(String... frontMatter) {
        String body = BODY;
        int from = 0;
        if (frontMatter.length > 0 && frontMatter[0].endsWith("\n")) {
            body = frontMatter[0];
            from = 1;
        }
        return "---\n" + String.join("\n", List.of(frontMatter).subList(from, frontMatter.length)) + "\n---\n\n" + body;
    }

    private static MockMultipartFile markdown(String name, String text) {
        return new MockMultipartFile("file", name, "text/markdown", text.getBytes(UTF_8));
    }

    private JsonNode preview(String bearer, MockMultipartFile... files) throws Exception {
        MockMultipartHttpServletRequestBuilder request = multipart(BASE + "/preview");
        for (MockMultipartFile file : files) {
            request.file(file);
        }
        request.header("Authorization", bearer);
        return data(mockMvc.perform(request).andExpect(status().isOk()));
    }

    /** The manifest the page builds from a preview: the hash, the selection and the opaque state of every file. */
    private String manifest(JsonNode preview, boolean... selected) {
        ArrayNode items = objectMapper.createArrayNode();
        for (int i = 0; i < preview.path("files").size(); i++) {
            JsonNode file = preview.path("files").get(i);
            ObjectNode item = items.addObject();
            item.put("sha256", file.path("sha256").asString());
            item.put("selected", selected[i]);
            if (file.path("previewState").isNull()) {
                item.putNull("state");
            } else {
                item.put("state", file.path("previewState").asString());
            }
        }
        return objectMapper.writeValueAsString(items);
    }

    private String manifestOf(String sha256, boolean selected, String state) {
        ObjectNode item = objectMapper.createObjectNode();
        item.put("sha256", sha256);
        item.put("selected", selected);
        if (state == null) {
            item.putNull("state");
        } else {
            item.put("state", state);
        }
        return objectMapper.writeValueAsString(objectMapper.createArrayNode().add(item));
    }

    private ResultActions apply(String bearer, String manifest, MockMultipartFile... files) throws Exception {
        MockMultipartHttpServletRequestBuilder request = multipart(BASE + "/apply");
        for (MockMultipartFile file : files) {
            request.file(file);
        }
        if (manifest != null) {
            request.param("manifest", manifest);
        }
        if (bearer != null) {
            request.header("Authorization", bearer);
        }
        return mockMvc.perform(request);
    }

    private ResultActions statusCall(String bearer) throws Exception {
        var request = get(BASE + "/status");
        if (bearer != null) {
            request.header("Authorization", bearer);
        }
        return mockMvc.perform(request);
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper.readTree(responseBody(result)).path("data");
    }

    private static String responseBody(ResultActions result) throws Exception {
        return result.andReturn().getResponse().getContentAsString(UTF_8);
    }

    private String message(ResultActions result) throws Exception {
        return objectMapper
                .readTree(responseBody(result))
                .path("error")
                .path("message")
                .asString();
    }

    private void assertError(ResultActions result, int status, String code) throws Exception {
        result.andExpect(status().is(status));
        assertThat(objectMapper
                        .readTree(responseBody(result))
                        .path("error")
                        .path("code")
                        .asString())
                .isEqualTo(code);
    }

    private UUID createPost(String bearer, String title, String slug) throws Exception {
        Map<String, Object> body = Map.of("title", title, "content", "Fixture body.", "slug", slug);
        JsonNode created = objectMapper.readTree(responseBody(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", bearer)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isCreated())));
        return UUID.fromString(created.path("data").path("id").asString());
    }
}
