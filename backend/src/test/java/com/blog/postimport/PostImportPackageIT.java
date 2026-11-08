package com.blog.postimport;

import static com.blog.support.ZipPackages.article;
import static com.blog.support.ZipPackages.image;
import static com.blog.support.ZipPackages.zip;
import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doCallRealMethod;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.media.service.MediaService;
import com.blog.postimport.format.PostFile;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.LogAssertions;
import com.blog.user.entity.UserRole;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockMultipartHttpServletRequestBuilder;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The ZIP packages of the post import through the HTTP API, with the real filter chain and a real database: the journey from
 * a package to a draft whose images are stored and whose references point at them, what a package may not be, that an apply
 * writes all or nothing (the images included), that a plain Markdown file next to a package is unaffected, who may call the
 * article preview, and that no log line and no log row holds text of a package.
 *
 * Every test has its own accounts (the rate limit is per person) and puts a random token into every slug and name: the
 * database is shared and never cleaned.
 */
@AutoConfigureMockMvc
class PostImportPackageIT extends AbstractIntegrationTest {

    private static final String BASE = "/api/v1/admin/post-import";
    private static final Pattern MEDIA_URL = Pattern.compile("/media/([0-9a-f-]{36})\\.(png|jpg)#(\\d+)x(\\d+)");

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @MockitoSpyBean
    private MediaService mediaService;

    private String admin;
    private String author;
    private String otherAuthor;
    private String reader;
    private String token;

    @BeforeEach
    void setUp() {
        token = UUID.randomUUID().toString().substring(0, 8);
        admin = auth.bearerFor(auth.createAccount("pkg-admin-" + token + "@blog.local", UserRole.ADMIN));
        author = auth.bearerFor(auth.createAuthor("pkg-author-" + token + "@blog.local"));
        otherAuthor = auth.bearerFor(auth.createAuthor("pkg-other-" + token + "@blog.local"));
        reader = auth.bearerFor(auth.createReader(auth.nextGithubId(), "pkg-reader-" + token));
    }

    @AfterEach
    void resetSpies() {
        reset(mediaService);
    }

    // --- The journey ------------------------------------------------------------------------------------------

    @Test
    void a_package_becomes_a_draft_whose_used_images_are_stored_and_whose_references_point_at_them() throws Exception {
        String body = "Intro paragraph.\n\n![Alt one](assets/one.png)\n\n"
                + ":::figure{src=\"assets/two.jpg\" alt=\"Figure two\"}\n:::\n\n"
                + ":::gallery{columns=2}\n![First](assets/one.png)\n![Third](assets/three.webp)\n:::\n\n"
                + "```markdown\n![in code](assets/unused.png)\n```\n";
        MockMultipartFile upload = packageFile("journey.zip", fullPackage("journey-" + token, body));
        long mediaBefore = count("media");

        JsonNode preview = preview(author, upload);
        JsonNode card = preview.path("files").get(0);

        assertThat(card.path("state").asString()).isEqualTo("new");
        assertThat(card.path("problemsTotal").asInt()).isZero();
        assertThat(card.path("pkg").path("assets").asInt()).isEqualTo(4);
        assertThat(card.path("pkg").path("usedAssets").asInt()).isEqualTo(3);
        assertThat(card.path("pkg").path("unusedAssets").asInt()).isEqualTo(1);
        assertThat(card.path("pkg").path("unsupportedItems").asInt()).isZero();
        assertThat(card.path("pkg").path("assetBytes").asInt()).isPositive();
        assertThat(card.path("notes").toString()).contains("asset_unused").contains("assets/unused.png");
        // The preview stores nothing and its card carries no body.
        assertThat(card.toString()).doesNotContain("Intro paragraph");
        assertThat(count("media")).isEqualTo(mediaBefore);

        JsonNode applied = data(apply(author, manifest(preview, true), upload).andExpect(status().isOk()));

        assertThat(applied.path("created").asInt()).isEqualTo(1);
        UUID postId =
                UUID.fromString(applied.path("files").get(0).path("postId").asString());
        Map<String, Object> row = jdbcTemplate.queryForMap("select status, content from posts where id = ?", postId);
        assertThat(row.get("status")).isEqualTo("DRAFT");
        String content = (String) row.get("content");
        // The block syntax is kept as written; only the places that name a file changed. The fenced code is untouched.
        assertThat(content).contains(":::figure{src=\"/media/").contains(":::gallery{columns=2}\n![First](/media/");
        assertThat(content).contains("```markdown\n![in code](assets/unused.png)\n```");
        assertThat(content.replace("![in code](assets/unused.png)", "")).doesNotContain("assets/");
        List<Map<String, Object>> media = jdbcTemplate.queryForList(
                "select id, content_type, width, height, alt_text, original_filename from media where post_id = ?"
                        + " order by original_filename",
                postId);
        assertThat(media)
                .extracting(m -> m.get("original_filename"))
                .containsExactly("one.png", "three.webp", "two.jpg");
        assertThat(media).extracting(m -> m.get("alt_text")).containsExactly("Alt one", "Third", "Figure two");
        // Every rewritten reference is the id, the extension and the size of a stored image.
        Matcher urls = MEDIA_URL.matcher(content);
        int found = 0;
        while (urls.find()) {
            found++;
            UUID id = UUID.fromString(urls.group(1));
            Map<String, Object> stored = media.stream()
                    .filter(m -> m.get("id").equals(id))
                    .findFirst()
                    .orElseThrow();
            assertThat(urls.group(2)).isEqualTo("png".equals(extensionOf(stored)) ? "png" : "jpg");
            assertThat(stored.get("width")).isEqualTo(Integer.parseInt(urls.group(3)));
            assertThat(stored.get("height")).isEqualTo(Integer.parseInt(urls.group(4)));
            mockMvc.perform(get("/api/v1/media/" + id + "." + urls.group(2))).andExpect(status().isOk());
        }
        // one.png twice, two.jpg once, three.webp once.
        assertThat(found).isEqualTo(4);
        // The unused image is not stored, and a draft shows nothing to the public.
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from media where original_filename = 'unused.png' and post_id = ?",
                        Integer.class,
                        postId))
                .isZero();
        mockMvc.perform(get("/api/v1/posts/journey-" + token)).andExpect(status().isNotFound());
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from post_revisions where post_id = ?", Integer.class, postId))
                .isZero();
    }

    @Test
    void a_package_updates_a_post_of_the_caller_and_stores_the_images_under_that_post() throws Exception {
        UUID postId = createPost(author, "Old " + token, "update-" + token);
        MockMultipartFile upload = packageFile(
                "update.zip",
                zip().add(
                                "article.md",
                                article(
                                        "New text.\n\n![Alt](assets/one.png)\n",
                                        "title: Updated " + token,
                                        "slug: update-" + token))
                        .add("assets/one.png", image("opaque.png"))
                        .build());

        JsonNode preview = preview(author, upload);
        assertThat(preview.path("files").get(0).path("state").asString()).isEqualTo("will_change");
        JsonNode applied = data(apply(author, manifest(preview, true), upload).andExpect(status().isOk()));

        assertThat(applied.path("updated").asInt()).isEqualTo(1);
        Map<String, Object> row = jdbcTemplate.queryForMap("select title, content from posts where id = ?", postId);
        assertThat(row.get("title")).isEqualTo("Updated " + token);
        assertThat((String) row.get("content"))
                .startsWith("New text.")
                .matches("(?s).*!\\[Alt]\\(/media/.*#\\d+x\\d+\\)\\s*");
        assertThat(count("media", "post_id", postId)).isEqualTo(1);
        // The text it replaced is kept as a revision, as for a Markdown update.
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from post_revisions where post_id = ?", Integer.class, postId))
                .isEqualTo(1);
    }

    @Test
    void importing_the_same_package_again_reuses_the_stored_images_and_writes_the_same_references() throws Exception {
        MockMultipartFile upload = packageFile(
                "again.zip", fullPackage("again-" + token, "![a](assets/one.png)\n\n![b](assets/two.jpg)\n"));
        data(apply(author, manifest(preview(author, upload), true), upload).andExpect(status().isOk()));
        UUID postId = jdbcTemplate.queryForObject("select id from posts where slug = ?", UUID.class, "again-" + token);
        String first = jdbcTemplate.queryForObject("select content from posts where id = ?", String.class, postId);
        long mediaAfterFirst = count("media", "post_id", postId);

        JsonNode second = data(
                apply(author, manifest(preview(author, upload), true), upload).andExpect(status().isOk()));

        assertThat(second.path("updated").asInt()).isEqualTo(1);
        assertThat(mediaAfterFirst).isEqualTo(2);
        assertThat(count("media", "post_id", postId)).isEqualTo(2);
        assertThat(jdbcTemplate.queryForObject("select content from posts where id = ?", String.class, postId))
                .isEqualTo(first);
    }

    @Test
    void a_package_whose_body_equals_the_stored_one_still_stores_its_images_and_is_not_unchanged() throws Exception {
        // The post was imported from a plain file, so it holds the paths of the package's images as they are written.
        UUID postId = createPost(author, "Same " + token, "same-" + token);
        setContent(postId, "![Alt](assets/one.png)\n");
        MockMultipartFile upload = packageFile(
                "same.zip",
                zip().add(
                                "article.md",
                                article("![Alt](assets/one.png)\n", "title: Same " + token, "slug: same-" + token))
                        .add("assets/one.png", image("opaque.png"))
                        .build());

        JsonNode preview = preview(author, upload);
        JsonNode card = preview.path("files").get(0);
        assertThat(card.path("state").asString()).isEqualTo("will_change");
        assertThat(card.path("changes").path("contentDiffers").asBoolean()).isTrue();
        JsonNode applied = data(apply(author, manifest(preview, true), upload).andExpect(status().isOk()));

        assertThat(applied.path("updated").asInt()).isEqualTo(1);
        assertThat(applied.path("unchanged").asInt()).isZero();
        assertThat(count("media", "post_id", postId)).isEqualTo(1);
        assertThat(contentOf(postId)).matches("(?s)!\\[Alt]\\(/media/.*#\\d+x\\d+\\)\\s*");
    }

    @Test
    void a_package_whose_body_differs_from_the_stored_one_only_in_whitespace_stores_its_images() throws Exception {
        UUID postId = createPost(author, "Old " + token, "blanks-" + token);
        setContent(postId, "\n\n![Alt](assets/one.png)");
        MockMultipartFile upload = packageFile(
                "blanks.zip",
                zip().add(
                                "article.md",
                                article("![Alt](assets/one.png)\n", "title: New " + token, "slug: blanks-" + token))
                        .add("assets/one.png", image("opaque.png"))
                        .build());

        JsonNode preview = preview(author, upload);
        assertThat(preview.path("files").get(0).path("state").asString()).isEqualTo("will_change");
        JsonNode applied = data(apply(author, manifest(preview, true), upload).andExpect(status().isOk()));

        assertThat(applied.path("updated").asInt()).isEqualTo(1);
        assertThat(count("media", "post_id", postId)).isEqualTo(1);
        assertThat(contentOf(postId)).contains("/media/").doesNotContain("assets/");
        assertThat(jdbcTemplate.queryForObject("select title from posts where id = ?", String.class, postId))
                .isEqualTo("New " + token);
    }

    @Test
    void a_package_that_uses_no_image_is_still_unchanged_when_its_body_equals_the_stored_one() throws Exception {
        UUID postId = createPost(author, "Plain " + token, "plainpkg-" + token);
        setContent(postId, "Only words.\n");
        MockMultipartFile upload = packageFile(
                "plainpkg.zip",
                zip().add("article.md", article("Only words.\n", "title: Plain " + token, "slug: plainpkg-" + token))
                        .build());

        JsonNode preview = preview(author, upload);

        assertThat(preview.path("files").get(0).path("state").asString()).isEqualTo("unchanged");
    }

    @Test
    void a_markdown_file_and_a_package_in_one_import_are_both_created() throws Exception {
        MockMultipartFile plain =
                markdown("plain.md", article("Plain body.\n", "title: Plain " + token, "slug: plain-" + token));
        MockMultipartFile packed = packageFile("packed.zip", fullPackage("packed-" + token, "![x](assets/one.png)\n"));

        JsonNode preview = preview(author, plain, packed);
        JsonNode applied =
                data(apply(author, manifest(preview, true, true), plain, packed).andExpect(status().isOk()));

        assertThat(applied.path("created").asInt()).isEqualTo(2);
        assertThat(applied.path("files").get(0).path("slug").asString()).isEqualTo("plain-" + token);
        assertThat(applied.path("files").get(1).path("slug").asString()).isEqualTo("packed-" + token);
        assertThat(preview.path("files").get(0).has("pkg")
                        && !preview.path("files").get(0).path("pkg").isNull())
                .isFalse();
        assertThat(preview.path("files").get(1).path("pkg").path("assets").asInt())
                .isEqualTo(4);
    }

    // --- What a package may not be ------------------------------------------------------------------------------

    @Test
    void a_missing_image_and_unsafe_content_are_problems_of_the_file_with_their_lines() throws Exception {
        String text = article(
                "First line.\n\n![Gone](assets/gone.png)\n\nA <script>x()</script> element.\n\n```html\n<script>shown()</script>\n```\n",
                "title: Problems " + token,
                "slug: problems-" + token);
        MockMultipartFile upload = packageFile(
                "problems.zip",
                zip().add("article.md", text)
                        .add("assets/one.png", image("opaque.png"))
                        .build());
        Snapshot before = snapshot();

        JsonNode card = preview(author, upload).path("files").get(0);

        assertThat(card.path("state").asString()).isEqualTo("error");
        List<String> problems = new ArrayList<>();
        card.path("problems")
                .forEach(p -> problems.add(
                        p.path("line").asInt() + ":" + p.path("message").asString()));
        assertThat(problems)
                .containsExactly(
                        lineOf(text, "![Gone]") + ":the image \"assets/gone.png\" is not in the package",
                        lineOf(text, "A <script>") + ":script elements are not allowed");
        assertThat(card.path("pkg").path("unusedAssets").asInt()).isEqualTo(1);

        // An apply of it is refused as a whole and writes nothing.
        // Its message is written to the log by the error handler, so it names the lines and not the path.
        ResultActions refused = apply(author, manifest(preview(author, upload), true), upload);
        assertError(refused, 400, "POST_IMPORT_INVALID");
        assertThat(message(refused))
                .isEqualTo("File 1 line " + lineOf(text, "![Gone]") + ": an image is not in the package; File 1 line "
                        + lineOf(text, "A <script>") + ": script elements are not allowed");
        assertThat(snapshot()).isEqualTo(before);
    }

    @Test
    void an_svg_image_is_refused_with_the_formats_that_are_supported() throws Exception {
        byte[] svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"></svg>".getBytes(UTF_8);
        MockMultipartFile upload = packageFile(
                "svg.zip",
                zip().add(
                                "article.md",
                                article("![Logo](assets/logo.svg)\n", "title: Svg " + token, "slug: svg-" + token))
                        .add("assets/logo.svg", svg)
                        .build());
        Snapshot before = snapshot();

        JsonNode card = preview(author, upload).path("files").get(0);

        assertThat(card.path("state").asString()).isEqualTo("error");
        assertThat(card.path("pkg").path("unsupportedItems").asInt()).isEqualTo(1);
        assertThat(card.path("problems").get(0).path("message").asString())
                .startsWith("entry 2 is an SVG image")
                .contains("PNG, JPEG or WebP");
        ResultActions refused = apply(author, manifestOf(card.path("sha256").asString(), true, null), upload);
        assertError(refused, 400, "POST_IMPORT_INVALID");
        assertThat(message(refused)).contains("entry 2 is an SVG image");
        assertThat(snapshot()).isEqualTo(before);
    }

    @Test
    void a_hostile_archive_is_an_error_card_not_a_failed_request_and_the_files_next_to_it_are_unaffected()
            throws Exception {
        byte[] nested = zip().add("article.md", "x").build();
        MockMultipartFile hostile = packageFile(
                "hostile.zip",
                zip().add("article.md", article("Body\n", "title: Hostile " + token, "slug: hostile-" + token))
                        .add("assets/inner.zip", nested)
                        .build());
        MockMultipartFile notAZip = packageFile("text.zip", "plain text, not an archive".getBytes(UTF_8));
        MockMultipartFile plain =
                markdown("fine.md", article("Fine.\n", "title: Fine " + token, "slug: fine-" + token));
        Snapshot before = snapshot();

        JsonNode preview = preview(author, hostile, notAZip, plain);

        assertThat(preview.path("files").get(0).path("state").asString()).isEqualTo("error");
        assertThat(preview.path("files")
                        .get(0)
                        .path("problems")
                        .get(0)
                        .path("message")
                        .asString())
                .isEqualTo("entry 2 is an archive; archives inside a package are not allowed");
        assertThat(preview.path("files").get(1).path("state").asString()).isEqualTo("error");
        assertThat(preview.path("files")
                        .get(1)
                        .path("problems")
                        .get(0)
                        .path("message")
                        .asString())
                .isEqualTo("the file is not a ZIP archive");
        assertThat(preview.path("files").get(2).path("state").asString()).isEqualTo("new");
        assertThat(preview.path("filesWithProblems").toString()).isEqualTo("[1,2]");

        // Selecting only the good one applies it; selecting a refused package refuses the import.
        data(apply(author, manifest(preview, false, false, true), hostile, notAZip, plain)
                .andExpect(status().isOk()));
        assertThat(postCount("fine-" + token)).isEqualTo(1);
        assertError(
                apply(author, manifest(preview, true, false, false), hostile, notAZip, plain),
                400,
                "POST_IMPORT_INVALID");
        assertThat(snapshot()).isNotEqualTo(before);
        assertThat(postCount("hostile-" + token)).isZero();
    }

    @Test
    void an_image_that_cannot_be_decoded_refuses_the_apply_naming_the_entry_and_writes_nothing() throws Exception {
        byte[] broken = new byte[200];
        System.arraycopy(image("opaque.png"), 0, broken, 0, 20);
        MockMultipartFile upload = packageFile(
                "broken.zip",
                zip().add(
                                "article.md",
                                article(
                                        "![Broken](assets/broken.png)\n",
                                        "title: Broken " + token,
                                        "slug: broken-" + token))
                        .add("assets/broken.png", broken)
                        .build());
        Snapshot before = snapshot();

        JsonNode preview = preview(author, upload);
        ResultActions refused = apply(author, manifest(preview, true), upload);

        // The preview only checks the magic bytes; the apply decodes the images, before it opens its transaction.
        assertThat(preview.path("files").get(0).path("state").asString()).isEqualTo("new");
        assertError(refused, 400, "POST_IMPORT_INVALID");
        assertThat(message(refused))
                .isEqualTo("File 1: entry 2 is an image that could not be read; it may be damaged or truncated");
        assertThat(snapshot()).isEqualTo(before);
    }

    @Test
    void the_slug_of_someone_elses_post_is_not_available_to_a_package() throws Exception {
        createPost(otherAuthor, "Theirs " + token, "theirs-" + token);
        MockMultipartFile upload = packageFile("theirs.zip", fullPackage("theirs-" + token, "![x](assets/one.png)\n"));
        Snapshot before = snapshot();

        JsonNode card = preview(author, upload).path("files").get(0);

        assertThat(card.path("state").asString()).isEqualTo("error");
        assertThat(card.path("problems").toString()).contains("this slug is not available");
        assertError(
                apply(author, manifestOf(card.path("sha256").asString(), true, null), upload),
                400,
                "POST_IMPORT_INVALID");
        assertThat(snapshot()).isEqualTo(before);
    }

    // --- All or nothing ---------------------------------------------------------------------------------------

    @Test
    void a_full_media_quota_in_the_middle_rolls_back_the_post_and_every_image_stored_before() throws Exception {
        MockMultipartFile upload =
                packageFile("quota.zip", fullPackage("quota-" + token, "![a](assets/one.png)\n![b](assets/two.jpg)\n"));
        String manifest = manifest(preview(author, upload), true);
        doCallRealMethod()
                .doThrow(new ApiException(
                        ErrorCode.MEDIA_QUOTA_EXCEEDED,
                        HttpStatus.UNPROCESSABLE_CONTENT,
                        "Storing this image would exceed"))
                .when(mediaService)
                .persistForPost(any(), any(), any(), any());
        Snapshot before = snapshot();

        ResultActions refused = apply(author, manifest, upload);

        assertError(refused, 422, "POST_IMPORT_MEDIA_QUOTA_EXCEEDED");
        assertThat(message(refused)).startsWith("File 1, entry ").contains("the image storage is full");
        assertThat(snapshot()).isEqualTo(before);
        assertThat(postCount("quota-" + token)).isZero();
    }

    @Test
    void a_busy_image_pipeline_is_its_own_error_and_writes_nothing() throws Exception {
        MockMultipartFile upload = packageFile("busy.zip", fullPackage("busy-" + token, "![a](assets/one.png)\n"));
        String manifest = manifest(preview(author, upload), true);
        doThrow(new ApiException(ErrorCode.MEDIA_BUSY, HttpStatus.SERVICE_UNAVAILABLE, "Another image"))
                .when(mediaService)
                .prepare(any(byte[].class), any(), any());
        Snapshot before = snapshot();

        ResultActions refused = apply(author, manifest, upload);

        assertError(refused, 503, "POST_IMPORT_MEDIA_BUSY");
        assertThat(message(refused)).startsWith("File 1, entry ");
        assertThat(snapshot()).isEqualTo(before);
    }

    @Test
    void the_images_are_prepared_before_the_transaction_and_a_plain_file_never_touches_the_media_service()
            throws Exception {
        MockMultipartFile packed = packageFile("order.zip", fullPackage("order-" + token, "![a](assets/one.png)\n"));
        MockMultipartFile plain =
                markdown("plain-order.md", article("Body.\n", "title: P " + token, "slug: po-" + token));

        AtomicBoolean preparedInTransaction = new AtomicBoolean(true);
        AtomicBoolean persistedInTransaction = new AtomicBoolean(false);
        doAnswer(call -> {
                    preparedInTransaction.set(TransactionSynchronizationManager.isActualTransactionActive());
                    return call.callRealMethod();
                })
                .when(mediaService)
                .prepare(any(byte[].class), any(), any());
        doAnswer(call -> {
                    persistedInTransaction.set(TransactionSynchronizationManager.isActualTransactionActive());
                    return call.callRealMethod();
                })
                .when(mediaService)
                .persistForPost(any(), any(), any(), any());

        data(apply(author, manifest(preview(author, plain), true), plain).andExpect(status().isOk()));
        verify(mediaService, never()).prepare(any(byte[].class), any(), any());

        data(apply(author, manifest(preview(author, packed), true), packed).andExpect(status().isOk()));
        assertThat(preparedInTransaction).isFalse();
        assertThat(persistedInTransaction).isTrue();
    }

    // --- The article preview ----------------------------------------------------------------------------------

    @Test
    void the_article_preview_answers_with_the_body_and_the_used_images_inlined_and_stores_nothing() throws Exception {
        byte[] one = image("opaque.png");
        MockMultipartFile upload = packageFile(
                "article.zip",
                fullPackage("article-" + token, "Text.\n\n![One](assets/one.png)\n\n![Two](assets/two.jpg)\n"));
        Snapshot before = snapshot();

        JsonNode answer = data(articlePreview(author, upload).andExpect(status().isOk()));

        assertThat(answer.path("fileName").asString()).isEqualTo("article.zip");
        assertThat(answer.path("title").asString()).isEqualTo("Pkg " + token);
        assertThat(answer.path("body").asString()).startsWith("Text.").contains("![One](assets/one.png)");
        assertThat(answer.path("bodyLine").asInt()).isEqualTo(6);
        assertThat(answer.path("problemsTotal").asInt()).isZero();
        assertThat(answer.path("pkg").path("usedAssets").asInt()).isEqualTo(2);
        JsonNode assets = answer.path("assets");
        assertThat(assets).hasSize(2);
        assertThat(assets.get(0).path("path").asString()).isEqualTo("assets/one.png");
        assertThat(assets.get(0).path("contentType").asString()).isEqualTo("image/png");
        assertThat(Base64.getDecoder().decode(assets.get(0).path("base64").asString()))
                .isEqualTo(one);
        assertThat(assets.get(0).path("width").asInt()).isPositive();
        assertThat(assets.get(0).path("height").asInt()).isPositive();
        assertThat(assets.get(1).path("contentType").asString()).isEqualTo("image/jpeg");
        assertThat(snapshot()).isEqualTo(before);
    }

    @Test
    void the_article_preview_of_a_markdown_file_has_a_body_and_no_images_and_a_bad_package_has_no_body()
            throws Exception {
        JsonNode plain =
                data(articlePreview(author, markdown("plain.md", article("Only text.\n", "title: Plain " + token)))
                        .andExpect(status().isOk()));
        JsonNode refused = data(articlePreview(author, packageFile("x.zip", "not a zip".getBytes(UTF_8)))
                .andExpect(status().isOk()));

        assertThat(plain.path("body").asString()).isEqualTo("Only text.\n");
        assertThat(plain.path("assets")).isEmpty();
        assertThat(plain.path("pkg").isNull()).isTrue();
        assertThat(refused.path("body").isNull()).isTrue();
        assertThat(refused.path("problemsTotal").asInt()).isEqualTo(1);
    }

    @Test
    void the_article_preview_is_for_admins_and_authors_and_has_a_limit_apart_from_the_preview() throws Exception {
        MockMultipartFile upload = markdown("a.md", article("Body.\n", "title: A " + token));

        articlePreview(admin, upload).andExpect(status().isOk());
        assertError(articlePreview(reader, upload), 403, "FORBIDDEN");
        assertError(articlePreview(null, upload), 401, "UNAUTHENTICATED");
        assertError(articlePreview(author, (MockMultipartFile) null), 400, "POST_IMPORT_INVALID_FILE");

        String limited = auth.bearerFor(auth.createAuthor("pkg-limit-" + token + "@blog.local"));
        int status = 400;
        int calls = 0;
        // Without a file part the call is refused after it was counted, so this writes nothing.
        while (status != 429 && calls < 400) {
            status = articlePreview(limited, (MockMultipartFile) null)
                    .andReturn()
                    .getResponse()
                    .getStatus();
            calls++;
        }
        assertThat(status).isEqualTo(429);
        // Another bucket: previewing many files did not use up the previews and applies of the same person.
        JsonNode preview = preview(limited, upload);
        assertThat(preview.path("files").get(0).path("state").asString()).isEqualTo("new");
        data(apply(limited, manifest(preview, true), upload).andExpect(status().isOk()));
    }

    // --- Hygiene ----------------------------------------------------------------------------------------------

    @Test
    void no_log_line_or_log_row_holds_a_name_or_text_of_a_package() throws Exception {
        String marker = "Quokka-Marker-" + token;
        String lower = marker.toLowerCase(Locale.ROOT);
        String body = "A body line with " + marker + "\n\n![Alt " + marker + "](assets/" + marker
                + ".png)\n\n![Two](assets/Second-" + marker + ".jpg)\n";
        byte[] good = zip().add(
                        "article.md",
                        article(body, "title: Title " + marker, "slug: slug-" + lower, "category: Cat " + marker))
                .add("assets/" + marker + ".png", image("opaque.png"))
                .add("assets/Second-" + marker + ".jpg", image("orient6.jpg"))
                .add("assets/Unused-" + marker + ".png", image("p3.png"))
                .build();
        byte[] hostile = zip().add("article.md", article("Body " + marker + "\n", "title: Hostile " + marker))
                .add("assets/" + marker + ".zip", zip().add("x.txt", "x").build())
                .build();
        byte[] unsafe = zip().add(
                        "article.md",
                        article(
                                "<script>" + marker + "</script> ![x](assets/missing-" + marker + ".png)\n",
                                "title: Unsafe " + marker))
                .build();
        byte[] broken = zip().add("article.md", article("![x](assets/" + marker + ".png)\n", "title: Broken " + marker))
                .add(
                        "assets/" + marker + ".png",
                        new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3})
                .build();
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        Logger imports = (Logger) LoggerFactory.getLogger("com.blog.postimport");
        Logger media = (Logger) LoggerFactory.getLogger("com.blog.media");
        Level previous = imports.getLevel();
        Level previousMedia = media.getLevel();
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        imports.setLevel(Level.DEBUG);
        media.setLevel(Level.DEBUG);
        List<String> refusals = new ArrayList<>();
        try {
            MockMultipartFile goodUpload = packageFile("name-" + marker + ".zip", good);
            String manifest = manifest(preview(author, goodUpload), true);
            articlePreview(author, goodUpload).andExpect(status().isOk());
            for (byte[] bytes : List.of(hostile, unsafe, broken)) {
                MockMultipartFile upload = packageFile("bad-" + marker + ".zip", bytes);
                refusals.add(responseBody(articlePreview(author, upload)));
                refusals.add(responseBody(apply(author, manifestOf(PostFile.sha256Hex(bytes), true, null), upload)));
            }
            MockMultipartFile notZip = packageFile("text-" + marker + ".zip", ("not a zip " + marker).getBytes(UTF_8));
            refusals.add(
                    responseBody(apply(author, manifestOf(PostFile.sha256Hex(notZip.getBytes()), true, null), notZip)));
            // A full quota after the first image: the rollback path logs too.
            doCallRealMethod()
                    .doThrow(new ApiException(ErrorCode.MEDIA_QUOTA_EXCEEDED, HttpStatus.UNPROCESSABLE_CONTENT, marker))
                    .when(mediaService)
                    .persistForPost(any(), any(), any(), any());
            refusals.add(responseBody(apply(author, manifest, goodUpload)));
            reset(mediaService);
            apply(author, manifest, goodUpload).andExpect(status().isOk());
        } finally {
            root.detachAppender(logs);
            imports.setLevel(previous);
            media.setLevel(previousMedia);
        }

        assertThat(logs.list)
                .anySatisfy(event -> assertThat(event.getFormattedMessage()).startsWith("post import applied"));
        LogAssertions.assertNoValues(logs.list, marker, lower);
        // An answer that names no path of the package is free of its text: the reader's refusals, the image errors and
        // the quota.
        // (The article preview answers with the name of the uploaded file, to its uploader; its problems hold nothing.)
        assertThat(objectMapper
                        .readTree(refusals.get(0))
                        .path("data")
                        .path("problems")
                        .toString())
                .isNotEmpty()
                .doesNotContain(marker, lower);
        assertThat(refusals.get(1)).isNotEmpty().doesNotContain(marker, lower);
        assertThat(refusals.get(3)).isNotEmpty().doesNotContain(marker, lower);
        assertThat(refusals.get(5)).isNotEmpty().doesNotContain(marker, lower);
        assertThat(refusals.get(6)).isNotEmpty().doesNotContain(marker, lower);
        assertThat(refusals.get(7)).isNotEmpty().doesNotContain(marker, lower);
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from post_import_log where cast(items as text) ilike ? or cast(file_hashes as text) ilike ?",
                        Integer.class,
                        "%" + marker + "%",
                        "%" + marker + "%"))
                .isZero();
    }

    // --- Helpers ----------------------------------------------------------------------------------------------

    /** A package of one article and four images: one.png, two.jpg, three.webp and unused.png. */
    private byte[] fullPackage(String slug, String body) {
        return zip().add("article.md", article(body, "title: Pkg " + token, "slug: " + slug))
                .add("assets/one.png", image("opaque.png"))
                .add("assets/two.jpg", image("orient6.jpg"))
                .add("assets/three.webp", image("alpha.webp"))
                .add("assets/unused.png", image("p3.png"))
                .build();
    }

    private static String extensionOf(Map<String, Object> media) {
        return "image/png".equals(media.get("content_type")) ? "png" : "jpg";
    }

    /** The 1-based line of the first line that contains the text. */
    private static int lineOf(String text, String part) {
        String[] lines = text.split("\n", -1);
        for (int i = 0; i < lines.length; i++) {
            if (lines[i].contains(part)) {
                return i + 1;
            }
        }
        throw new IllegalArgumentException(part);
    }

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
                "media",
                "media_content",
                "post_import_log")) {
            counts.put(table, jdbcTemplate.queryForObject("select count(*) from " + table, Integer.class));
        }
        return new Snapshot(counts);
    }

    private long count(String table) {
        return jdbcTemplate.queryForObject("select count(*) from " + table, Long.class);
    }

    private long count(String table, String column, UUID value) {
        return jdbcTemplate.queryForObject(
                "select count(*) from " + table + " where " + column + " = ?", Long.class, value);
    }

    private void setContent(UUID postId, String content) {
        jdbcTemplate.update("update posts set content = ? where id = ?", content, postId);
    }

    private String contentOf(UUID postId) {
        return jdbcTemplate.queryForObject("select content from posts where id = ?", String.class, postId);
    }

    private int postCount(String slug) {
        return jdbcTemplate.queryForObject("select count(*) from posts where slug = ?", Integer.class, slug);
    }

    private static MockMultipartFile markdown(String name, String text) {
        return new MockMultipartFile("file", name, "text/markdown", text.getBytes(UTF_8));
    }

    private static MockMultipartFile packageFile(String name, byte[] bytes) {
        return new MockMultipartFile("file", name, "application/zip", bytes);
    }

    private JsonNode preview(String bearer, MockMultipartFile... files) throws Exception {
        MockMultipartHttpServletRequestBuilder request = multipart(BASE + "/preview");
        for (MockMultipartFile file : files) {
            request.file(file);
        }
        request.header("Authorization", bearer);
        ResultActions result = mockMvc.perform(request);
        if (result.andReturn().getResponse().getStatus() != 200) {
            return objectMapper.readTree(responseBody(result));
        }
        return data(result);
    }

    private ResultActions articlePreview(String bearer, MockMultipartFile file) throws Exception {
        MockMultipartHttpServletRequestBuilder request = multipart(BASE + "/article-preview");
        if (file != null) {
            request.file(file);
        }
        if (bearer != null) {
            request.header("Authorization", bearer);
        }
        return mockMvc.perform(request);
    }

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

    private void assertError(JsonNode answer, int status, String code) {
        assertThat(answer.path("error").path("code").asString()).isEqualTo(code);
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
