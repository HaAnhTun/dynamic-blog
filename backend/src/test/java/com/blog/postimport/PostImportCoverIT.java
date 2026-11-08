package com.blog.postimport;

import static com.blog.support.ZipPackages.article;
import static com.blog.support.ZipPackages.image;
import static com.blog.support.ZipPackages.zip;
import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.postimport.format.PostFileLimits;
import com.blog.postimport.format.PostPackage;
import com.blog.postimport.format.PostPackageReader;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.LogAssertions;
import com.blog.user.entity.UserRole;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The cover image of a post package through the HTTP API, with the real filter chain and a real database: what the preview
 * says, what an apply does for a new post and for one that has a cover, the problems of a cover key, the export of the cover
 * and the round trip (import, export, import again). Every test has its own accounts and a random token in every slug.
 */
@AutoConfigureMockMvc
class PostImportCoverIT extends AbstractIntegrationTest {

    private static final String IMPORT = "/api/v1/admin/post-import";
    private static final String ALT = "A red door";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String admin;
    private String author;
    private String otherAuthor;
    private String token;

    @BeforeEach
    void setUp() {
        token = UUID.randomUUID().toString().substring(0, 8);
        admin = auth.bearerFor(auth.createAccount("cov-admin-" + token + "@blog.local", UserRole.ADMIN));
        author = auth.bearerFor(auth.createAuthor("cov-author-" + token + "@blog.local"));
        otherAuthor = auth.bearerFor(auth.createAuthor("cov-other-" + token + "@blog.local"));
    }

    // --- Preview and apply ----------------------------------------------------------------------------------

    @Test
    void a_new_post_gets_the_cover_of_the_package_and_the_cover_counts_as_a_used_image() throws Exception {
        String slug = "cover-new-" + token;
        MockMultipartFile upload = pkg("new.zip", slug, "assets/cover.png", ALT, image("opaque.png"));

        JsonNode card = preview(author, upload).path("files").get(0);

        assertThat(card.path("state").asString()).isEqualTo("new");
        assertThat(codes(card)).contains("cover_will_be_set").doesNotContain("asset_unused", "key_ignored");
        assertThat(card.path("pkg").path("assets").asInt()).isEqualTo(1);
        assertThat(card.path("pkg").path("usedAssets").asInt()).isEqualTo(1);
        assertThat(card.path("pkg").path("unusedAssets").asInt()).isZero();

        apply(author, upload).andExpect(status().isOk());

        Map<String, Object> cover = coverOf(slug);
        assertThat(cover.get("alt_text")).isEqualTo(ALT);
        assertThat(cover.get("post_id")).isNull();
        assertThat(cover.get("content_type")).isEqualTo("image/png");
    }

    @Test
    void a_package_replaces_the_cover_the_post_has_and_the_old_image_is_deleted() throws Exception {
        String slug = "cover-replace-" + token;
        UUID id = createDraft(author, slug);
        uploadCover(author, id, "orient6.jpg", "Old description");
        Map<String, Object> before = coverOf(slug);
        MockMultipartFile upload = pkg("replace.zip", slug, "assets/cover.png", "New description", image("opaque.png"));

        JsonNode card = preview(author, upload).path("files").get(0);

        // The text of the file equals the post: the cover is the only change.
        assertThat(card.path("state").asString()).isEqualTo("will_change");
        assertThat(card.path("changes").path("contentDiffers").asBoolean()).isFalse();
        assertThat(codes(card)).contains("cover_will_be_replaced").doesNotContain("cover_will_be_set");

        apply(author, upload).andExpect(status().isOk());

        Map<String, Object> after = coverOf(slug);
        assertThat(after.get("id")).isNotEqualTo(before.get("id"));
        assertThat(after.get("sha256")).isNotEqualTo(before.get("sha256"));
        assertThat(after.get("alt_text")).isEqualTo("New description");
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from media where id = ?", Integer.class, UUID.fromString((String)
                                before.get("id"))))
                .isZero();
    }

    @Test
    void a_post_without_a_cover_gets_it_with_the_set_note() throws Exception {
        String slug = "cover-set-" + token;
        createDraft(author, slug);
        MockMultipartFile upload = pkg("set.zip", slug, "assets/cover.png", null, image("opaque.png"));

        JsonNode card = preview(author, upload).path("files").get(0);

        assertThat(card.path("state").asString()).isEqualTo("will_change");
        assertThat(codes(card)).contains("cover_will_be_set");
        apply(author, upload).andExpect(status().isOk());
        assertThat(coverOf(slug).get("alt_text")).isNull();
    }

    @Test
    void a_cover_changed_between_the_preview_and_the_apply_makes_the_apply_out_of_date() throws Exception {
        String slug = "cover-stale-" + token;
        UUID id = createDraft(author, slug);
        uploadCover(author, id, "orient6.jpg", "First");
        MockMultipartFile upload = pkg("stale.zip", slug, "assets/cover.png", null, image("opaque.png"));
        JsonNode preview = preview(author, upload);

        uploadCover(author, id, "p3.png", "Second");

        ResultActions result = apply(author, manifest(preview), upload);
        result.andExpect(status().isConflict());
        assertThat(objectMapper
                        .readTree(result.andReturn().getResponse().getContentAsString(UTF_8))
                        .path("error")
                        .path("code")
                        .asString())
                .isEqualTo("POST_IMPORT_PREVIEW_OUT_OF_DATE");
        assertThat(coverOf(slug).get("alt_text")).isEqualTo("Second");
    }

    @Test
    void an_author_cannot_set_the_cover_of_a_post_of_someone_else_and_an_admin_can() throws Exception {
        String slug = "cover-owner-" + token;
        UUID id = createDraft(author, slug);
        uploadCover(author, id, "orient6.jpg", "Mine");
        Object mine = coverOf(slug).get("id");
        MockMultipartFile upload = pkg("owner.zip", slug, "assets/cover.png", "Theirs", image("opaque.png"));

        assertThat(preview(otherAuthor, upload)
                        .path("files")
                        .get(0)
                        .path("state")
                        .asString())
                .isEqualTo("error");
        apply(otherAuthor, manifestOf(upload, null), upload).andExpect(status().isBadRequest());
        assertThat(coverOf(slug).get("id")).isEqualTo(mine);

        apply(admin, upload).andExpect(status().isOk());
        assertThat(coverOf(slug).get("alt_text")).isEqualTo("Theirs");
    }

    // --- Problems -------------------------------------------------------------------------------------------

    @Test
    void a_cover_in_a_plain_markdown_file_is_a_problem_that_blocks_the_file() throws Exception {
        String text =
                article("Body.\n", "title: Plain " + token, "slug: cover-plain-" + token, "cover: assets/cover.png");
        MockMultipartFile upload = new MockMultipartFile("file", "plain.md", "text/markdown", text.getBytes(UTF_8));

        JsonNode card = preview(author, upload).path("files").get(0);

        assertThat(card.path("state").asString()).isEqualTo("error");
        assertThat(card.path("problems")).anySatisfy(problem -> {
            assertThat(problem.path("key").asString()).isEqualTo("cover");
            assertThat(problem.path("line").asInt()).isEqualTo(4);
        });
        apply(author, manifestOf(upload, null), upload).andExpect(status().isBadRequest());
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from posts where slug = ?", Integer.class, "cover-plain-" + token))
                .isZero();
    }

    @Test
    void a_cover_that_is_not_in_the_package_or_leaves_it_or_is_not_an_image_blocks_the_file() throws Exception {
        List<MockMultipartFile> uploads = List.of(
                pkg(
                        "missing.zip",
                        "cover-missing-" + token,
                        "assets/absent.png",
                        null,
                        "assets/cover.png",
                        image("opaque.png")),
                pkg(
                        "outside.zip",
                        "cover-outside-" + token,
                        "../cover.png",
                        null,
                        "assets/cover.png",
                        image("opaque.png")),
                pkg(
                        "remote.zip",
                        "cover-remote-" + token,
                        "https://example.com/c.png",
                        null,
                        "assets/cover.png",
                        image("opaque.png")),
                pkg("text.zip", "cover-text-" + token, "assets/cover.png", null, "not an image".getBytes(UTF_8)));
        for (MockMultipartFile upload : uploads) {
            JsonNode card = preview(author, upload).path("files").get(0);

            assertThat(card.path("state").asString()).isEqualTo("error");
            assertThat(card.path("problems")).anySatisfy(problem -> {
                assertThat(problem.path("key").asString()).isEqualTo("cover");
                assertThat(problem.path("line").asInt()).isEqualTo(4);
            });
            apply(author, manifestOf(upload, null), upload).andExpect(status().isBadRequest());
        }
        assertThat(jdbcTemplate.queryForObject(
                        "select count(*) from posts where slug like ?", Integer.class, "cover-%-" + token))
                .isZero();
    }

    // --- Export and the round trip ------------------------------------------------------------------------------

    @Test
    void the_export_carries_the_stored_cover_and_importing_it_gives_the_same_cover_back() throws Exception {
        String slug = "cover-trip-" + token;
        MockMultipartFile upload = pkg("trip.zip", slug, "assets/cover.png", ALT, image("opaque.png"));
        apply(author, upload).andExpect(status().isOk());
        UUID id = jdbcTemplate.queryForObject("select id from posts where slug = ?", UUID.class, slug);
        Map<String, Object> before = coverOf(slug);
        byte[] bytesBefore = coverBytes((String) before.get("id"));

        byte[] zip = export(author, id);

        PostPackage pack = PostPackageReader.read(zip, PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);
        assertThat(pack.markdown()).contains("\ncover: assets/cover-1.png\n").contains("\ncover_alt: " + ALT + "\n");
        assertThat(pack.assets()).singleElement().satisfies(asset -> {
            assertThat(asset.path()).isEqualTo("assets/cover-1.png");
            assertThat(asset.data()).isEqualTo(bytesBefore);
        });

        // The same post again: nothing to do, a package whose images are all the cover included.
        MockMultipartFile same = new MockMultipartFile("file", "same.zip", "application/zip", zip);
        assertThat(preview(author, same).path("files").get(0).path("state").asString())
                .isEqualTo("unchanged");

        // A clean state: the post is gone, the package makes it again with the same cover pixels, size and bytes.
        jdbcTemplate.update("delete from posts where id = ?", id);
        apply(author, same).andExpect(status().isOk());
        Map<String, Object> after = coverOf(slug);
        assertThat(after.get("id")).isNotEqualTo(before.get("id"));
        assertThat(after.get("sha256")).isEqualTo(before.get("sha256"));
        assertThat(after.get("width")).isEqualTo(before.get("width"));
        assertThat(after.get("height")).isEqualTo(before.get("height"));
        assertThat(after.get("alt_text")).isEqualTo(ALT);
        assertThat(coverBytes((String) after.get("id"))).isEqualTo(bytesBefore);
    }

    @Test
    void a_post_without_a_cover_exports_without_cover_keys() throws Exception {
        UUID id = createDraft(author, "cover-none-" + token);

        PostPackage pack = PostPackageReader.read(export(author, id), PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);

        assertThat(pack.markdown()).doesNotContain("cover:").doesNotContain("cover_alt:");
        assertThat(pack.assets()).isEmpty();
    }

    @Test
    void no_log_line_and_no_refusal_holds_the_path_the_name_or_the_description_of_a_cover() throws Exception {
        String marker = "Quokka-Cover-" + token;
        String lower = marker.toLowerCase(Locale.ROOT);
        String slug = "cover-log-" + lower;
        MockMultipartFile good =
                pkg("log-" + marker + ".zip", slug, "assets/" + marker + ".png", ALT + marker, image("opaque.png"));
        MockMultipartFile missing = pkg(
                "missing-" + marker + ".zip",
                slug + "-x",
                "assets/Missing-" + marker + ".png",
                null,
                "assets/other.png",
                image("opaque.png"));
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        Logger imports = (Logger) LoggerFactory.getLogger("com.blog.postimport");
        Level previous = imports.getLevel();
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        imports.setLevel(Level.DEBUG);
        List<String> answers = new ArrayList<>();
        try {
            JsonNode preview = preview(author, good);
            apply(author, manifest(preview), good).andExpect(status().isOk());
            UUID id = jdbcTemplate.queryForObject("select id from posts where slug = ?", UUID.class, slug);
            export(author, id);
            answers.add(responseBody(apply(author, manifestOf(missing, null), missing)));
        } finally {
            root.detachAppender(logs);
            imports.setLevel(previous);
        }

        assertThat(logs.list)
                .anySatisfy(event -> assertThat(event.getFormattedMessage()).startsWith("post import applied"));
        LogAssertions.assertNoValues(logs.list, marker, lower, ALT);
        assertThat(answers.get(0)).isNotEmpty().contains("cover").doesNotContain(marker, lower);
    }

    @Test
    void the_stored_cover_with_another_description_is_a_change_and_without_one_it_is_none() throws Exception {
        String slug = "cover-alt-" + token;
        apply(author, pkg("alt.zip", slug, "assets/cover.png", ALT, image("opaque.png")))
                .andExpect(status().isOk());
        byte[] stored = coverBytes((String) coverOf(slug).get("id"));

        MockMultipartFile sameImageNoAlt = pkg("same.zip", slug, "assets/cover.png", null, stored);
        MockMultipartFile sameImageOtherAlt = pkg("other.zip", slug, "assets/cover.png", "Another door", stored);

        assertThat(preview(author, sameImageNoAlt)
                        .path("files")
                        .get(0)
                        .path("state")
                        .asString())
                .isEqualTo("unchanged");
        JsonNode changed = preview(author, sameImageOtherAlt).path("files").get(0);
        assertThat(changed.path("state").asString()).isEqualTo("will_change");
        assertThat(codes(changed)).contains("cover_will_be_replaced");
        apply(author, sameImageOtherAlt).andExpect(status().isOk());
        assertThat(coverOf(slug).get("alt_text")).isEqualTo("Another door");
    }

    @Test
    void the_cover_may_also_be_shown_in_the_body_and_the_other_images_stay_unused() throws Exception {
        String slug = "cover-body-" + token;
        byte[] bytes = zip().add(
                        "article.md",
                        article(
                                "![Door](assets/cover.png)\n",
                                "title: Cover " + token,
                                "slug: " + slug,
                                "cover: assets/cover.png"))
                .add("assets/cover.png", image("opaque.png"))
                .add("assets/spare.png", image("p3.png"))
                .build();
        MockMultipartFile upload = new MockMultipartFile("file", "body.zip", "application/zip", bytes);

        JsonNode card = preview(author, upload).path("files").get(0);

        assertThat(card.path("pkg").path("usedAssets").asInt()).isEqualTo(1);
        assertThat(card.path("pkg").path("unusedAssets").asInt()).isEqualTo(1);
        assertThat(card.path("notes"))
                .filteredOn(note -> "asset_unused".equals(note.path("code").asString()))
                .extracting(note -> note.path("key").asString())
                .containsExactly("assets/spare.png");
        apply(author, upload).andExpect(status().isOk());
        UUID id = jdbcTemplate.queryForObject("select id from posts where slug = ?", UUID.class, slug);
        assertThat(jdbcTemplate.queryForObject("select count(*) from media where post_id = ?", Integer.class, id))
                .isEqualTo(1);
        assertThat(coverOf(slug).get("post_id")).isNull();
    }

    @Test
    void a_jpeg_and_a_webp_cover_keep_their_format_and_size_and_a_webp_keeps_its_bytes_too() throws Exception {
        for (String resource : List.of("orient6.jpg", "alpha.webp")) {
            String extension = resource.substring(resource.length() - 3);
            String slug = "cover-" + extension + "-" + token;
            apply(author, pkg("first.zip", slug, "assets/cover." + extension, null, image(resource)))
                    .andExpect(status().isOk());
            UUID id = jdbcTemplate.queryForObject("select id from posts where slug = ?", UUID.class, slug);
            Map<String, Object> before = coverOf(slug);
            byte[] zip = export(author, id);
            jdbcTemplate.update("delete from posts where id = ?", id);

            apply(author, new MockMultipartFile("file", "again.zip", "application/zip", zip))
                    .andExpect(status().isOk());

            Map<String, Object> after = coverOf(slug);
            assertThat(after.get("content_type")).isEqualTo(before.get("content_type"));
            assertThat(after.get("width")).isEqualTo(before.get("width"));
            assertThat(after.get("height")).isEqualTo(before.get("height"));
            if (extension.equals("webp")) {
                assertThat(after.get("sha256")).isEqualTo(before.get("sha256"));
            }
        }
    }

    // --- Helpers ----------------------------------------------------------------------------------------------

    /** A package whose article names {@code cover} and has the bytes at the entry of the same path. */
    private MockMultipartFile pkg(String name, String slug, String cover, String alt, byte[] imageBytes) {
        return pkg(name, slug, cover, alt, cover, imageBytes);
    }

    /** A package whose article names {@code cover} on line 4 (the fence is line 1, the title 2, the slug 3). */
    private MockMultipartFile pkg(String name, String slug, String cover, String alt, String entry, byte[] imageBytes) {
        List<String> lines = new ArrayList<>(List.of("title: Cover " + token, "slug: " + slug, "cover: " + cover));
        if (alt != null) {
            lines.add("cover_alt: " + alt);
        }
        byte[] bytes = zip().add("article.md", article("Placeholder.\n", lines.toArray(String[]::new)))
                .add(entry, imageBytes)
                .build();
        return new MockMultipartFile("file", name, "application/zip", bytes);
    }

    private JsonNode preview(String bearer, MockMultipartFile file) throws Exception {
        return data(mockMvc.perform(multipart(IMPORT + "/preview").file(file).header("Authorization", bearer))
                .andExpect(status().isOk()));
    }

    private ResultActions apply(String bearer, MockMultipartFile file) throws Exception {
        return apply(bearer, manifest(preview(bearer, file)), file);
    }

    private ResultActions apply(String bearer, String manifest, MockMultipartFile file) throws Exception {
        return mockMvc.perform(multipart(IMPORT + "/apply")
                .file(file)
                .param("manifest", manifest)
                .header("Authorization", bearer));
    }

    private String manifest(JsonNode preview) {
        ArrayNode items = objectMapper.createArrayNode();
        JsonNode file = preview.path("files").get(0);
        ObjectNode item = items.addObject();
        item.put("sha256", file.path("sha256").asString());
        item.put("selected", true);
        if (file.path("previewState").isNull()) {
            item.putNull("state");
        } else {
            item.put("state", file.path("previewState").asString());
        }
        return objectMapper.writeValueAsString(items);
    }

    private String manifestOf(MockMultipartFile file, String state) throws Exception {
        ObjectNode item = objectMapper.createObjectNode();
        item.put("sha256", com.blog.postimport.format.PostFile.sha256Hex(file.getBytes()));
        item.put("selected", true);
        if (state == null) {
            item.putNull("state");
        } else {
            item.put("state", state);
        }
        return objectMapper.writeValueAsString(objectMapper.createArrayNode().add(item));
    }

    private byte[] export(String bearer, UUID id) throws Exception {
        return mockMvc.perform(get("/api/v1/admin/posts/" + id + "/export").header("Authorization", bearer))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsByteArray();
    }

    private UUID createDraft(String bearer, String slug) throws Exception {
        JsonNode created = data(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", bearer)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "title", "Cover " + token, "content", "Placeholder.", "slug", slug, "language", "en"))))
                .andExpect(status().isCreated()));
        return UUID.fromString(created.path("id").asString());
    }

    /** The cover as the editor uploads it. */
    private void uploadCover(String bearer, UUID postId, String resource, String alt) throws Exception {
        MockMultipartFile file = new MockMultipartFile("file", resource, "application/octet-stream", image(resource));
        mockMvc.perform(multipart("/api/v1/admin/posts/" + postId + "/cover")
                        .file(file)
                        .param("altText", alt)
                        .header("Authorization", bearer))
                .andExpect(status().isOk());
    }

    private Map<String, Object> coverOf(String slug) {
        return jdbcTemplate.queryForMap(
                "select cast(m.id as text) as id, m.sha256, m.alt_text, m.post_id, m.content_type, m.width, m.height"
                        + " from posts p join media m on m.id = p.cover_media_id where p.slug = ?",
                slug);
    }

    private byte[] coverBytes(String mediaId) {
        return jdbcTemplate.queryForObject(
                "select data from media_content where media_id = ?", byte[].class, UUID.fromString(mediaId));
    }

    private static List<String> codes(JsonNode card) {
        List<String> codes = new ArrayList<>();
        card.path("notes").forEach(note -> codes.add(note.path("code").asString()));
        return codes;
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper.readTree(responseBody(result)).path("data");
    }

    private static String responseBody(ResultActions result) throws Exception {
        return result.andReturn().getResponse().getContentAsString(UTF_8);
    }
}
