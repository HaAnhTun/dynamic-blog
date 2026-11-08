package com.blog.postimport;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.category.dto.CategoryRequest;
import com.blog.category.service.CategoryService;
import com.blog.post.dto.PostCreateRequest;
import com.blog.post.dto.PostUpdateRequest;
import com.blog.post.service.PostService;
import com.blog.postimport.format.PostFile;
import com.blog.postimport.format.PostFileValues;
import com.blog.postimport.format.PostMarkdownWriter;
import com.blog.postimport.service.PreviewState;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.tag.dto.TagRequest;
import com.blog.tag.service.TagService;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockMultipartHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Updating existing posts from files through the HTTP API of the post import, with the real filter chain and a real database:
 * matching by the current slug, what an author and an admin may touch, the merge (a missing or empty key never clears
 * anything), "unchanged" in the normal form of the download, the revision of the replaced text, the stale-state refusals and
 * the round trip with the download writer.
 *
 * Every test has its own accounts and puts a random token into every slug and name: the database is shared and never cleaned.
 */
@AutoConfigureMockMvc
class PostImportUpdateIT extends AbstractIntegrationTest {

    private static final String BASE = "/api/v1/admin/post-import";
    private static final String STORED_BODY = "The stored body of the post.\n";
    private static final String NEW_BODY = "A new body from the file.\n";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PostService postService;

    @Autowired
    private CategoryService categoryService;

    @Autowired
    private TagService tagService;

    private User adminUser;
    private User authorUser;
    private User otherAuthorUser;
    private String admin;
    private String author;
    private String otherAuthor;
    private String token;

    @BeforeEach
    void setUp() {
        token = UUID.randomUUID().toString().substring(0, 8);
        adminUser = auth.createAccount("post-update-admin-" + token + "@blog.local", UserRole.ADMIN);
        admin = auth.bearerFor(adminUser);
        authorUser = auth.createAuthor("post-update-author-" + token + "@blog.local");
        author = auth.bearerFor(authorUser);
        otherAuthorUser = auth.createAuthor("post-update-other-" + token + "@blog.local");
        otherAuthor = auth.bearerFor(otherAuthorUser);
    }

    // --- Same file twice, edits, revisions ------------------------------------------------------------------

    @Test
    void importing_the_same_file_twice_makes_one_post_and_the_second_time_is_unchanged_with_no_trace()
            throws Exception {
        String slug = "twice-" + token;
        MockMultipartFile upload = markdown("a.md", file("title: Twice " + token, "slug: " + slug));
        apply(author, manifest(preview(author, upload), true), upload).andExpect(status().isOk());
        long logsBefore = logCount(authorUser);

        JsonNode second = preview(author, upload);
        JsonNode file = second.path("files").get(0);
        JsonNode applied = data(apply(author, manifest(second, true), upload).andExpect(status().isOk()));

        assertThat(file.path("state").asString()).isEqualTo("unchanged");
        assertThat(file.path("previewState").isNull()).isTrue();
        assertThat(applied.path("importId").isNull()).isTrue();
        assertThat(applied.path("unchanged").asInt()).isEqualTo(1);
        assertThat(applied.path("created").asInt()).isZero();
        assertThat(applied.path("updated").asInt()).isZero();
        assertThat(applied.path("files").get(0).path("result").asString()).isEqualTo("unchanged");
        assertThat(applied.path("files").get(0).path("slug").asString()).isEqualTo(slug);
        assertThat(postCount(slug)).isEqualTo(1);
        assertThat(postCount(slug + "-2")).isZero();
        assertThat(revisionCount(postId(slug))).isZero();
        assertThat(logCount(authorUser)).isEqualTo(logsBefore);
    }

    @Test
    void an_edited_file_updates_the_same_post_and_keeps_the_replaced_text_even_when_a_revision_is_minutes_old()
            throws Exception {
        String slug = "edited-" + token;
        UUID postId = createPost(authorUser, "Edited " + token, slug, STORED_BODY, null, null, null);
        // An edit a moment ago: its revision is inside the ten-minute window that merges consecutive saves.
        postService.update(
                postId,
                new PostUpdateRequest("Edited " + token, null, "Text before the import.\n", null, Set.of(), null),
                authorUser.getId());
        assertThat(revisionCount(postId)).isEqualTo(1);
        MockMultipartFile upload = markdown("e.md", file(NEW_BODY, "title: Edited " + token, "slug: " + slug));

        JsonNode preview = preview(author, upload);
        JsonNode previewed = preview.path("files").get(0);
        JsonNode applied = data(apply(author, manifest(preview, true), upload).andExpect(status().isOk()));

        assertThat(previewed.path("state").asString()).isEqualTo("will_change");
        assertThat(previewed.path("changes").path("contentDiffers").asBoolean()).isTrue();
        assertThat(previewed.path("changes").path("title").path("before").asString())
                .isEqualTo(previewed.path("changes").path("title").path("after").asString());
        assertThat(applied.path("updated").asInt()).isEqualTo(1);
        assertThat(applied.path("files").get(0).path("result").asString()).isEqualTo("updated");
        assertThat(applied.path("files").get(0).path("postId").asString()).isEqualTo(postId.toString());
        assertThat(postCount(slug)).isEqualTo(1);
        assertThat(jdbcTemplate.queryForObject("select content from posts where id = ?", String.class, postId))
                .isEqualTo(NEW_BODY);
        // The text the import replaced is the newest revision, one more than before: the update after it wrote no
        // second.
        assertThat(revisionCount(postId)).isEqualTo(2);
        Map<String, Object> newest = jdbcTemplate.queryForMap(
                "select id, content from post_revisions where post_id = ? order by created_at desc, id desc limit 1",
                postId);
        assertThat(newest.get("content")).isEqualTo("Text before the import.\n");
        JsonNode item = logItem(applied.path("importId").asLong());
        assertThat(item.path("action").asString()).isEqualTo("updated");
        assertThat(item.path("postId").asString()).isEqualTo(postId.toString());
        assertThat(item.path("previousRevisionId").asString())
                .isEqualTo(newest.get("id").toString());
        assertThat(data(statusCall(author)).path("lastImport").path("updated").asInt())
                .isEqualTo(1);
    }

    @Test
    void a_category_only_or_tags_only_change_writes_no_revision_and_logs_a_null_revision_id() throws Exception {
        String slug = "taxonomy-" + token;
        UUID oldCategory = categoryService
                .create(new CategoryRequest("Old category " + token, null))
                .id();
        UUID oldTag = tagService.create(new TagRequest("old-tag-" + token)).id();
        UUID postId = createPost(authorUser, "Taxonomy " + token, slug, STORED_BODY, null, oldCategory, Set.of(oldTag));
        MockMultipartFile upload = markdown(
                "t.md",
                file(
                        STORED_BODY,
                        "title: Taxonomy " + token,
                        "slug: " + slug,
                        "category: New category " + token,
                        "tags: old-tag-" + token + ", added-tag-" + token));

        JsonNode preview = preview(author, upload);
        JsonNode changes = preview.path("files").get(0).path("changes");
        JsonNode applied = data(apply(author, manifest(preview, true), upload).andExpect(status().isOk()));

        assertThat(changes.path("contentDiffers").asBoolean()).isFalse();
        assertThat(changes.path("tagsAdded").asInt()).isEqualTo(1);
        assertThat(changes.path("tagsKept").asInt()).isEqualTo(1);
        assertThat(changes.path("tagsRemoved").asInt()).isZero();
        assertThat(revisionCount(postId)).isZero();
        JsonNode item = logItem(applied.path("importId").asLong());
        assertThat(item.path("previousRevisionId").isNull()).isTrue();
        assertThat(item.path("previousCategoryId").asString()).isEqualTo(oldCategory.toString());
        assertThat(item.path("previousTagIds").get(0).asString()).isEqualTo(oldTag.toString());
        assertThat(jdbcTemplate.queryForObject(
                        "select c.name from posts p join categories c on c.id = p.category_id where p.id = ?",
                        String.class,
                        postId))
                .isEqualTo("New category " + token);
        assertThat(tagNames(postId)).containsExactly("added-tag-" + token, "old-tag-" + token);
    }

    // --- Merge ----------------------------------------------------------------------------------------------

    @Test
    void missing_and_empty_keys_never_clear_the_stored_category_tags_or_description() throws Exception {
        String slug = "merge-" + token;
        UUID category = categoryService
                .create(new CategoryRequest("Kept category " + token, null))
                .id();
        UUID tag = tagService.create(new TagRequest("kept-tag-" + token)).id();
        UUID postId =
                createPost(authorUser, "Merge " + token, slug, STORED_BODY, "Kept description.", category, Set.of(tag));
        MockMultipartFile upload = markdown(
                "m.md", file(NEW_BODY, "title: Merge " + token, "slug: " + slug, "excerpt:", "category:", "tags:"));

        apply(author, manifest(preview(author, upload), true), upload).andExpect(status().isOk());

        Map<String, Object> row =
                jdbcTemplate.queryForMap("select excerpt, category_id, content from posts where id = ?", postId);
        assertThat(row.get("excerpt")).isEqualTo("Kept description.");
        assertThat(row.get("category_id")).isEqualTo(category);
        assertThat(row.get("content")).isEqualTo(NEW_BODY);
        assertThat(tagNames(postId)).containsExactly("kept-tag-" + token);
    }

    @Test
    void a_language_different_from_the_stored_one_is_an_error_and_the_same_language_is_fine() throws Exception {
        String slug = "language-" + token;
        createPost(authorUser, "Language " + token, slug, STORED_BODY, null, null, null);
        String stored = jdbcTemplate.queryForObject("select language from posts where slug = ?", String.class, slug);
        String other = stored.equals("en") ? "vi" : "en";

        JsonNode different = preview(
                        author, markdown("l.md", file("title: L " + token, "slug: " + slug, "language: " + other)))
                .path("files")
                .get(0);
        JsonNode same = preview(
                        author, markdown("l.md", file("title: L " + token, "slug: " + slug, "language: " + stored)))
                .path("files")
                .get(0);

        assertThat(different.path("state").asString()).isEqualTo("error");
        assertThat(different.path("problems").get(0).path("key").asString()).isEqualTo("language");
        assertThat(different.path("problems").toString()).doesNotContain(token);
        assertThat(same.path("state").asString()).isNotEqualTo("error");
        assertThat(same.path("language").asString()).isEqualTo(stored);
    }

    @Test
    void a_file_with_a_translation_of_gets_the_ignored_note_for_an_existing_post_too() throws Exception {
        String slug = "translation-note-" + token;
        createPost(authorUser, "Translation note " + token, slug, STORED_BODY, null, null, null);
        MockMultipartFile upload = markdown(
                "t.md",
                file(NEW_BODY, "title: Translation note " + token, "slug: " + slug, "translation_of: other-" + token));

        JsonNode file = preview(author, upload).path("files").get(0);

        assertThat(file.path("state").asString()).isEqualTo("will_change");
        assertThat(codes(file.path("notes"))).contains("translation_of_ignored");
        JsonNode note = file.path("notes").get(codes(file.path("notes")).indexOf("translation_of_ignored"));
        assertThat(note.path("key").asString()).isEqualTo("translation_of");
        assertThat(note.path("line").asInt()).isEqualTo(4);
    }

    @Test
    void a_note_says_the_category_is_missing_only_when_neither_the_stored_post_nor_the_file_has_one() throws Exception {
        UUID category = categoryService
                .create(new CategoryRequest("Present category " + token, null))
                .id();
        createPost(authorUser, "Bare " + token, "bare-" + token, STORED_BODY, null, null, null);
        createPost(authorUser, "Kept " + token, "kept-" + token, STORED_BODY, null, category, null);
        createPost(authorUser, "Chosen " + token, "chosen-" + token, STORED_BODY, null, null, null);
        MockMultipartFile bare = markdown("bare.md", file("title: Bare " + token, "slug: bare-" + token));
        MockMultipartFile kept = markdown("kept.md", file("title: Kept " + token, "slug: kept-" + token));
        MockMultipartFile chosen = markdown(
                "chosen.md",
                file("title: Chosen " + token, "slug: chosen-" + token, "category: Present category " + token));

        JsonNode files = preview(author, bare, kept, chosen).path("files");

        // The note never makes a file differ: the bare file is still unchanged and the chosen one changes for the
        // category.
        assertThat(files.get(0).path("state").asString()).isEqualTo("unchanged");
        assertThat(codes(files.get(0).path("notes"))).containsExactly("category_missing");
        assertThat(files.get(0).path("notes").get(0).path("key").asString()).isEqualTo("category");
        assertThat(files.get(1).path("state").asString()).isEqualTo("unchanged");
        assertThat(codes(files.get(1).path("notes"))).isEmpty();
        assertThat(files.get(2).path("state").asString()).isEqualTo("will_change");
        assertThat(codes(files.get(2).path("notes"))).isEmpty();
    }

    @Test
    void featured_status_and_author_never_change_and_a_file_that_differs_only_in_featured_is_unchanged()
            throws Exception {
        String slug = "featured-" + token;
        UUID postId = createPost(authorUser, "Featured " + token, slug, STORED_BODY, null, null, null);
        int rank = ThreadLocalRandom.current().nextInt(1_000_000, 2_000_000);
        jdbcTemplate.update("update posts set featured = true, featured_rank = ? where id = ?", rank, postId);
        MockMultipartFile only =
                markdown("f.md", file(STORED_BODY, "title: Featured " + token, "slug: " + slug, "featured: false"));
        MockMultipartFile forged = markdown(
                "g.md",
                file(
                        NEW_BODY,
                        "title: Featured " + token,
                        "slug: " + slug,
                        "featured: false",
                        "status: published",
                        "author: forged-" + token));

        JsonNode onlyFeatured = preview(admin, only).path("files").get(0);
        JsonNode previewed = preview(admin, forged);
        apply(admin, manifest(previewed, true), forged).andExpect(status().isOk());

        assertThat(onlyFeatured.path("state").asString()).isEqualTo("unchanged");
        assertThat(codes(previewed.path("files").get(0).path("notes")))
                .contains("featured_ignored", "status_ignored")
                .doesNotContain("published_goes_live");
        Map<String, Object> row = jdbcTemplate.queryForMap(
                "select featured, featured_rank, status, author_id from posts where id = ?", postId);
        assertThat(row.get("featured")).isEqualTo(true);
        assertThat(row.get("featured_rank")).isEqualTo(rank);
        assertThat(row.get("status")).isEqualTo("DRAFT");
        assertThat(row.get("author_id")).isEqualTo(authorUser.getId());
    }

    // --- Ownership ------------------------------------------------------------------------------------------

    @Test
    void a_post_the_author_deleted_is_no_longer_theirs_to_update_by_import_and_its_slug_stays_reserved()
            throws Exception {
        String slug = "hidden-" + token;
        UUID postId = createPost(authorUser, "My hidden draft " + token, slug, STORED_BODY, null, null, null);
        jdbcTemplate.update(
                "update posts set status = 'ARCHIVED', deleted_at = now(), deleted_by = ? where id = ?",
                authorUser.getId(),
                postId);
        MockMultipartFile upload = markdown("h.md", file(NEW_BODY, "title: Again " + token, "slug: " + slug));

        JsonNode asAuthor = preview(author, upload).path("files").get(0);
        ResultActions refused = apply(author, manifestOf(asAuthor.path("sha256").asString(), true, null), upload);

        assertThat(asAuthor.path("state").asString()).isEqualTo("error");
        assertThat(asAuthor.path("problems").get(0).path("message").asString()).contains("not available");
        refused.andExpect(status().isBadRequest());
        assertThat(jdbcTemplate.queryForObject("select content from posts where id = ?", String.class, postId))
                .isEqualTo(STORED_BODY);
    }

    @Test
    void an_author_cannot_update_another_authors_post_and_learns_nothing_while_an_admin_can_and_keeps_the_author()
            throws Exception {
        String slug = "theirs-" + token;
        UUID postId = createPost(otherAuthorUser, "Their draft " + token, slug, STORED_BODY, null, null, null);
        MockMultipartFile upload = markdown("o.md", file(NEW_BODY, "title: Mine " + token, "slug: " + slug));

        JsonNode asAuthor = preview(author, upload).path("files").get(0);
        ResultActions refused = apply(author, manifestOf(asAuthor.path("sha256").asString(), true, null), upload);

        assertThat(asAuthor.path("state").asString()).isEqualTo("error");
        assertThat(asAuthor.path("problems").get(0).path("message").asString())
                .contains("not available")
                .doesNotContain(slug, token);
        assertThat(asAuthor.toString()).doesNotContain("Their draft");
        refused.andExpect(status().isBadRequest());
        assertThat(responseBody(refused)).doesNotContain(slug, token, "Their draft");
        assertThat(jdbcTemplate.queryForObject("select content from posts where id = ?", String.class, postId))
                .isEqualTo(STORED_BODY);

        JsonNode asAdmin = preview(admin, upload);
        apply(admin, manifest(asAdmin, true), upload).andExpect(status().isOk());
        assertThat(asAdmin.path("files").get(0).path("state").asString()).isEqualTo("will_change");
        Map<String, Object> row = jdbcTemplate.queryForMap("select content, author_id from posts where id = ?", postId);
        assertThat(row.get("content")).isEqualTo(NEW_BODY);
        assertThat(row.get("author_id")).isEqualTo(otherAuthorUser.getId());
    }

    // --- Published posts and stale state --------------------------------------------------------------------

    @Test
    void a_published_post_is_previewed_with_its_status_and_a_live_warning_and_applies_only_as_previewed()
            throws Exception {
        String slug = "live-" + token;
        UUID postId = createPost(authorUser, "Live " + token, slug, STORED_BODY, null, null, null);
        publish(postId);
        MockMultipartFile upload = markdown("p.md", file(NEW_BODY, "title: Live " + token, "slug: " + slug));

        JsonNode preview = preview(author, upload);
        JsonNode file = preview.path("files").get(0);
        PreviewState state =
                PreviewState.decode(file.path("previewState").asString()).orElseThrow();
        apply(author, manifest(preview, true), upload).andExpect(status().isOk());

        assertThat(file.path("state").asString()).isEqualTo("will_change");
        assertThat(state.action()).isEqualTo("update");
        assertThat(state.status()).isEqualTo("PUBLISHED");
        assertThat(state.postId()).isEqualTo(postId);
        assertThat(codes(file.path("notes"))).contains("published_goes_live");
        assertThat(jdbcTemplate.queryForObject("select status from posts where id = ?", String.class, postId))
                .isEqualTo("PUBLISHED");
        assertThat(jdbcTemplate.queryForObject("select content from posts where id = ?", String.class, postId))
                .isEqualTo(NEW_BODY);
    }

    @Test
    void a_draft_published_after_the_preview_is_refused_and_so_is_a_post_edited_after_it() throws Exception {
        String published = "stale-published-" + token;
        String edited = "stale-edited-" + token;
        UUID publishedId = createPost(authorUser, "Stale one " + token, published, STORED_BODY, null, null, null);
        UUID editedId = createPost(authorUser, "Stale two " + token, edited, STORED_BODY, null, null, null);
        MockMultipartFile first = markdown("s1.md", file(NEW_BODY, "title: Stale one " + token, "slug: " + published));
        MockMultipartFile second = markdown("s2.md", file(NEW_BODY, "title: Stale two " + token, "slug: " + edited));

        JsonNode preview = preview(author, first, second);
        publish(publishedId);
        ResultActions publishedRefusal = apply(author, manifest(preview, true, false), first, second);
        assertError(publishedRefusal, 409, "POST_IMPORT_PREVIEW_OUT_OF_DATE");
        assertThat(message(publishedRefusal)).startsWith("1 file is").doesNotContain(token, published);

        jdbcTemplate.update("update posts set content = 'edited elsewhere' where id = ?", editedId);
        ResultActions editedRefusal = apply(author, manifest(preview, false, true), first, second);
        assertError(editedRefusal, 409, "POST_IMPORT_PREVIEW_OUT_OF_DATE");
        assertThat(message(editedRefusal)).startsWith("1 file is").doesNotContain(token, edited);

        // Unselected files are not compared; nothing was written by either refusal.
        assertThat(jdbcTemplate.queryForObject("select content from posts where id = ?", String.class, publishedId))
                .isEqualTo(STORED_BODY);
        assertThat(jdbcTemplate.queryForObject("select content from posts where id = ?", String.class, editedId))
                .isEqualTo("edited elsewhere");
        assertThat(revisionCount(publishedId) + revisionCount(editedId)).isZero();
    }

    // --- Concurrency and hygiene ----------------------------------------------------------------------------

    @Test
    void two_simultaneous_applies_of_the_same_edit_update_the_post_once_and_record_one_revision() throws Exception {
        String slug = "parallel-" + token;
        UUID postId = createPost(authorUser, "Parallel " + token, slug, STORED_BODY, null, null, null);
        MockMultipartFile upload = markdown("p.md", file(NEW_BODY, "title: Parallel " + token, "slug: " + slug));
        String manifest = manifest(preview(author, upload), true);
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        List<JsonNode> answers = new ArrayList<>();
        try {
            List<Future<JsonNode>> results = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                results.add(pool.submit(() -> {
                    start.await();
                    return data(apply(author, manifest, upload).andExpect(status().isOk()));
                }));
            }
            start.countDown();
            for (Future<JsonNode> result : results) {
                answers.add(result.get(60, TimeUnit.SECONDS));
            }
        } finally {
            pool.shutdownNow();
        }

        // The one that comes second reads the post the first one wrote, under the locks, and finds nothing to change.
        assertThat(answers.stream()
                        .mapToInt(answer -> answer.path("updated").asInt())
                        .sum())
                .isEqualTo(1);
        assertThat(answers.stream()
                        .mapToInt(answer -> answer.path("unchanged").asInt())
                        .sum())
                .isEqualTo(1);
        assertThat(revisionCount(postId)).isEqualTo(1);
        assertThat(jdbcTemplate.queryForObject("select content from posts where id = ?", String.class, postId))
                .isEqualTo(NEW_BODY);
    }

    @Test
    void no_log_line_answer_or_log_row_of_an_update_holds_a_value_of_the_file_or_of_the_post() throws Exception {
        String marker = "Quokka-Marker-" + token;
        String lower = marker.toLowerCase(Locale.ROOT);
        UUID category = categoryService
                .create(new CategoryRequest("Stored category " + marker, null))
                .id();
        createPost(
                authorUser,
                "Stored title " + marker,
                "mine-" + lower,
                STORED_BODY,
                "Stored excerpt " + marker,
                category,
                Set.of());
        createPost(otherAuthorUser, "Theirs " + marker, "theirs-" + lower, STORED_BODY, null, null, Set.of());
        UUID staleId = createPost(authorUser, "Stale " + marker, "stale-" + lower, STORED_BODY, null, null, Set.of());
        MockMultipartFile mine = markdown(
                "mine-" + marker + ".md",
                file(
                        NEW_BODY,
                        "title: Changed " + marker,
                        "slug: mine-" + lower,
                        "tags: tag " + marker,
                        "key with " + marker + ": x"));
        MockMultipartFile theirs =
                markdown("theirs-" + marker + ".md", file(NEW_BODY, "title: T " + marker, "slug: theirs-" + lower));
        MockMultipartFile stale =
                markdown("stale-" + marker + ".md", file(NEW_BODY, "title: Stale " + marker, "slug: stale-" + lower));
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        Logger imports = (Logger) LoggerFactory.getLogger("com.blog.postimport");
        Level previous = imports.getLevel();
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        imports.setLevel(Level.DEBUG);
        List<String> errors = new ArrayList<>();
        String applied;
        try {
            JsonNode stalePreview = preview(author, stale);
            jdbcTemplate.update("update posts set content = 'edited elsewhere' where id = ?", staleId);
            errors.add(responseBody(apply(author, manifest(stalePreview, true), stale)));
            errors.add(
                    responseBody(apply(author, manifestOf(PostFile.sha256Hex(theirs.getBytes()), true, null), theirs)));
            applied = responseBody(
                    apply(author, manifest(preview(author, mine), true), mine).andExpect(status().isOk()));
        } finally {
            root.detachAppender(logs);
            imports.setLevel(previous);
        }

        assertThat(logs.list)
                .anySatisfy(event -> assertThat(event.getFormattedMessage()).contains("post import applied"));
        for (ILoggingEvent event : logs.list) {
            assertThat(event.getFormattedMessage()).doesNotContain(marker, lower);
        }
        for (String body : errors) {
            assertThat(body).isNotEmpty().doesNotContain(marker, lower);
        }
        assertThat(applied).contains("updated");
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from post_import_log where created_by = ? and (cast(items as text) ilike ? or cast(file_hashes as text) ilike ?)",
                        Integer.class,
                        authorUser.getId(),
                        "%" + marker + "%",
                        "%" + marker + "%"))
                .isZero();
    }

    // --- Round trip -----------------------------------------------------------------------------------------

    @Test
    void posts_written_by_the_download_writer_import_back_as_unchanged_for_the_awkward_cases() throws Exception {
        UUID category = categoryService
                .create(new CategoryRequest("Round trip --- category " + token, null))
                .id();
        UUID plain = tagService.create(new TagRequest("plain-" + token)).id();
        UUID comma = tagService.create(new TagRequest("red, green " + token)).id();
        String nfd = Normalizer.normalize("Cafe", Normalizer.Form.NFD) + new String(Character.toChars(0x301));
        List<UUID> posts = new ArrayList<>();
        posts.add(createPost(
                authorUser,
                "No newline " + token,
                "rt-1-" + token,
                "Ends without a line break",
                null,
                category,
                Set.of(plain)));
        posts.add(createPost(
                authorUser, "Three --- hyphens " + token, "rt-2-" + token, STORED_BODY, "A --- B", category, Set.of()));
        posts.add(createPost(
                authorUser, "Comma tag " + token, "rt-3-" + token, STORED_BODY, null, category, Set.of(comma, plain)));
        posts.add(createPost(
                authorUser,
                "Many lines " + token,
                "rt-4-" + token,
                STORED_BODY,
                "first line\nsecond line\n\nthird",
                category,
                Set.of()));
        posts.add(createPost(
                authorUser,
                "Windows " + token,
                "rt-5-" + token,
                "line one\r\nline two\r\n" + nfd + "\r\n",
                null,
                null,
                Set.of()));
        List<MockMultipartFile> uploads = new ArrayList<>();
        for (UUID id : posts) {
            uploads.add(markdown("rt-" + uploads.size() + ".md", download(id)));
        }

        JsonNode files =
                preview(author, uploads.toArray(MockMultipartFile[]::new)).path("files");

        for (int i = 0; i < files.size(); i++) {
            assertThat(files.get(i).path("state").asString())
                    .as("file %d", i + 1)
                    .isEqualTo("unchanged");
            assertThat(files.get(i).path("newTags").size()).isZero();
            assertThat(files.get(i).path("newCategories").size()).isZero();
        }
    }

    // --- Helpers --------------------------------------------------------------------------------------------

    /** The file the download writes for a stored post, read straight from the database. */
    private String download(UUID postId) {
        Map<String, Object> row = jdbcTemplate.queryForMap(
                "select p.title, p.slug, p.language, p.excerpt, p.content, p.status, c.name as category"
                        + " from posts p left join categories c on c.id = p.category_id where p.id = ?",
                postId);
        List<String> tags = tagNames(postId);
        return PostMarkdownWriter.write(new PostFileValues(
                (String) row.get("title"),
                (String) row.get("slug"),
                (String) row.get("language"),
                (String) row.get("excerpt"),
                (String) row.get("category"),
                tags,
                false,
                row.get("status").toString().toLowerCase(Locale.ROOT),
                null,
                (String) row.get("content")));
    }

    private UUID createPost(
            User owner, String title, String slug, String content, String excerpt, UUID categoryId, Set<UUID> tagIds) {
        return postService
                .create(
                        owner.getId(),
                        new PostCreateRequest(
                                title, excerpt, content, categoryId, tagIds == null ? Set.of() : tagIds, slug, null))
                .id();
    }

    private void publish(UUID postId) {
        jdbcTemplate.update("update posts set status = 'PUBLISHED', published_at = now() where id = ?", postId);
    }

    private List<String> tagNames(UUID postId) {
        return jdbcTemplate.queryForList(
                "select t.name from post_tags pt join tags t on t.id = pt.tag_id where pt.post_id = ? order by t.name",
                String.class,
                postId);
    }

    private static List<String> codes(JsonNode notes) {
        List<String> codes = new ArrayList<>();
        notes.forEach(note -> codes.add(note.path("code").asString()));
        return codes;
    }

    private JsonNode logItem(long importId) throws Exception {
        String items = jdbcTemplate.queryForObject(
                "select cast(items as text) from post_import_log where id = ?", String.class, importId);
        return objectMapper.readTree(items).get(0);
    }

    private long logCount(User user) {
        return jdbcTemplate.queryForObject(
                "select count(*) from post_import_log where created_by = ?", Long.class, user.getId());
    }

    private int revisionCount(UUID postId) {
        return jdbcTemplate.queryForObject(
                "select count(*) from post_revisions where post_id = ?", Integer.class, postId);
    }

    private int postCount(String slug) {
        return jdbcTemplate.queryForObject("select count(*) from posts where slug = ?", Integer.class, slug);
    }

    private UUID postId(String slug) {
        return jdbcTemplate.queryForObject("select id from posts where slug = ?", UUID.class, slug);
    }

    /** A file with the stored-body default; a first argument that ends with a line break is the body. */
    private static String file(String... frontMatter) {
        String body = STORED_BODY;
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
        request.param("manifest", manifest);
        request.header("Authorization", bearer);
        return mockMvc.perform(request);
    }

    private ResultActions statusCall(String bearer) throws Exception {
        return mockMvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get(BASE + "/status")
                .header("Authorization", bearer));
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
}
