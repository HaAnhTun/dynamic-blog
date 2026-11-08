package com.blog.post;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.RequestBuilder;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * What an AUTHOR may write, through the real filter chain and the real database, with small limits: tags per post, posts per
 * day, tags and categories created in an hour and in the whole catalog, images per post and the share of the media quota. An
 * ADMIN is exempt from all of them. A translation draft counts as a post created. The SQL of the share (sum of bytes by uploader, by everyone who is not an ADMIN) runs against
 * PostgreSQL here; the arithmetic is in MediaServiceTest.
 *
 * A database of its own, so that the catalog counts are exact.
 */
@AutoConfigureMockMvc
@TestPropertySource(
        properties = {
            "app.author-quota.max-tags-per-post=2",
            "app.author-quota.max-posts-per-day=4",
            "app.author-quota.max-body-images-per-post=2",
            "app.author-quota.max-tags=20",
            "app.author-quota.max-categories=5",
            "app.author-quota.media-per-author=2KB",
            "app.rate-limit.taxonomy-create.per-hour=2",
            "app.rate-limit.post-write.per-ten-minutes=12"
        })
class AuthorQuotaIT extends AbstractIntegrationTest {

    private static final String POSTS = "/api/v1/admin/posts";
    private static final String IMPORT = "/api/v1/admin/post-import";

    @DynamicPropertySource
    static void isolatedDatabase(DynamicPropertyRegistry registry) {
        AbstractIntegrationTest.useFreshDatabase(registry, "author_quota_it");
    }

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    private record Author(UUID id, String bearer) {}

    private Author newAuthorAccount() {
        User user = auth.createAuthor("quota-" + UUID.randomUUID() + "@blog.local");
        return new Author(user.getId(), auth.bearerFor(user));
    }

    private String newAuthor() {
        return newAuthorAccount().bearer();
    }

    private UUID newTag() {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)", id, "Quota tag " + id, "quota-tag-" + id);
        return id;
    }

    private ResultActions createPost(String bearer, String title, List<UUID> tags) throws Exception {
        List<String> ids = new ArrayList<>();
        tags.forEach(tag -> ids.add(tag.toString()));
        return mockMvc.perform(post(POSTS)
                .header("Authorization", bearer)
                .contentType(APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(
                        Map.of("title", title + " " + UUID.randomUUID(), "content", "Body", "tagIds", ids))));
    }

    private UUID created(ResultActions result) throws Exception {
        JsonNode data = objectMapper
                .readTree(result.andExpect(status().isCreated())
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .path("data");
        return UUID.fromString(data.path("id").asString());
    }

    @Test
    void an_author_post_carries_at_most_the_tag_limit_on_create_and_on_save_and_an_admin_is_exempt() throws Exception {
        String author = newAuthor();
        String admin = auth.bearerForAdmin();
        List<UUID> three = List.of(newTag(), newTag(), newTag());

        createPost(author, "Too many tags", three)
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        UUID id = created(createPost(author, "Two tags", three.subList(0, 2)));

        mockMvc.perform(put(POSTS + "/" + id)
                        .header("Authorization", author)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "title", "Edited",
                                "content", "Body",
                                "tagIds", three.stream().map(UUID::toString).toList()))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));

        created(createPost(admin, "Admin with three tags", three));
    }

    @Test
    void an_author_creates_a_limited_number_of_posts_a_day_and_an_admin_is_not_counted() throws Exception {
        String author = newAuthor();
        for (int i = 0; i < 4; i++) {
            created(createPost(author, "Post " + i, List.of()));
        }

        createPost(author, "One too many", List.of())
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("AUTHOR_QUOTA_EXCEEDED"));

        String admin = auth.bearerForAdmin();
        for (int i = 0; i < 6; i++) {
            created(createPost(admin, "Admin post " + i, List.of()));
        }
    }

    @Test
    void a_translation_draft_counts_as_a_post_created_so_create_unlink_and_create_again_stops_at_the_daily_number()
            throws Exception {
        Author author = newAuthorAccount();
        UUID first = created(createPost(author.bearer(), "Source one", List.of()));
        UUID second = created(createPost(author.bearer(), "Source two", List.of()));
        created(createPost(author.bearer(), "Source three", List.of()));

        UUID draft = createdTranslation(author.bearer(), first, "en");
        assertThat(createdTodayBy(author)).as("three posts and the draft").isEqualTo(4);

        // Unlinking the draft frees nothing: the row stays, and so does its place in the day.
        mockMvc.perform(delete(POSTS + "/" + draft + "/translations").header("Authorization", author.bearer()))
                .andExpect(status().isNoContent());
        translation(author.bearer(), first, "en")
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("AUTHOR_QUOTA_EXCEEDED"));
        translation(author.bearer(), second, "en")
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("AUTHOR_QUOTA_EXCEEDED"));
        assertThat(createdTodayBy(author)).as("a refused draft creates no row").isEqualTo(4);
    }

    @Test
    void an_admin_creating_a_translation_draft_is_not_counted_or_refused() throws Exception {
        String admin = auth.bearerForAdmin();
        UUID source = created(createPost(admin, "Admin source", List.of()));
        for (int i = 0; i < 5; i++) {
            created(createPost(admin, "Admin extra " + i, List.of()));
        }

        createdTranslation(admin, source, "en");
    }

    @Test
    void a_translation_draft_spends_a_write_of_the_post_write_limit_and_over_it_is_rate_limited() throws Exception {
        Author author = newAuthorAccount();
        UUID source = created(createPost(author.bearer(), "Rate limited source", List.of()));
        createdTranslation(author.bearer(), source, "en");

        // The second draft in the same language is a conflict, but it still counts as a write.
        for (int attempt = 0; attempt < 10; attempt++) {
            translation(author.bearer(), source, "en")
                    .andExpect(status().isConflict())
                    .andExpect(jsonPath("$.error.code").value("TRANSLATION_CONFLICT"));
        }
        translation(author.bearer(), source, "en")
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("RATE_LIMITED"));
        assertThat(createdTodayBy(author)).isEqualTo(2);
    }

    private ResultActions translation(String bearer, UUID post, String language) throws Exception {
        return mockMvc.perform(post(POSTS + "/" + post + "/translations")
                .header("Authorization", bearer)
                .contentType(APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("language", language))));
    }

    private UUID createdTranslation(String bearer, UUID post, String language) throws Exception {
        return created(translation(bearer, post, language));
    }

    private long createdTodayBy(Author author) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM posts WHERE author_id = ? AND created_at > now() - interval '1 day'",
                Long.class,
                author.id());
    }

    @Test
    void an_import_stopped_by_a_limit_of_the_author_answers_with_that_limit_and_not_that_the_data_changed()
            throws Exception {
        String author = newAuthor();
        for (int i = 0; i < 4; i++) {
            created(createPost(author, "Before the import " + i, List.of()));
        }
        String text = """
                ---
                title: Over the limit
                slug: import-over-the-limit-%s
                ---

                A short body.
                """.formatted(UUID.randomUUID());
        MockMultipartFile file = new MockMultipartFile("file", "over.md", "text/markdown", text.getBytes(UTF_8));
        JsonNode preview = objectMapper
                .readTree(mockMvc.perform(
                                multipart(IMPORT + "/preview").file(file).header("Authorization", author))
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString(UTF_8))
                .path("data");
        Map<String, Object> item = Map.of(
                "sha256", preview.path("files").get(0).path("sha256").asString(),
                "selected", true,
                "state", preview.path("files").get(0).path("previewState").asString());

        // The fifth post of the day: the limit speaks for itself. "The data changed, preview again" would send the
        // author round in
        // circles, because a new preview changes nothing.
        mockMvc.perform(multipart(IMPORT + "/apply")
                        .file(file)
                        .param("manifest", objectMapper.writeValueAsString(List.of(item)))
                        .header("Authorization", author))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("AUTHOR_QUOTA_EXCEEDED"));
    }

    private JsonNode previewOf(String bearer, MockMultipartFile file) throws Exception {
        return objectMapper
                .readTree(mockMvc.perform(
                                multipart(IMPORT + "/preview").file(file).header("Authorization", bearer))
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString(UTF_8))
                .path("data")
                .path("files")
                .get(0);
    }

    private static MockMultipartFile markdown(String text) {
        return new MockMultipartFile("file", "tags.md", "text/markdown", text.getBytes(UTF_8));
    }

    private static boolean hasTagLimitProblem(JsonNode file) {
        for (JsonNode problem : file.path("problems")) {
            if ("tags".equals(problem.path("key").asString())
                    && problem.path("message").asString().contains("at most 2 tags")) {
                return true;
            }
        }
        return false;
    }

    @Test
    void the_preview_of_an_authors_new_post_refuses_more_tags_than_a_post_may_have_and_the_apply_does_not_loop()
            throws Exception {
        String author = newAuthor();
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        String text = """
                ---
                title: Too many tags
                slug: import-tags-%1$s
                tags: alpha-%1$s, beta-%1$s, gamma-%1$s
                ---

                A short body.
                """.formatted(suffix);

        JsonNode preview = previewOf(author, markdown(text));

        // Before the fix the preview called this file new and fine, and the apply then failed on the tag count and
        // answered
        // "the data changed, preview again" (409 POST_IMPORT_PREVIEW_OUT_OF_DATE): a loop, since a new preview says the
        // same.
        assertThat(preview.path("state").asString()).isEqualTo("error");
        assertThat(hasTagLimitProblem(preview)).isTrue();
        Map<String, Object> item = Map.of("sha256", preview.path("sha256").asString(), "selected", true);
        mockMvc.perform(multipart(IMPORT + "/apply")
                        .file(markdown(text))
                        .param("manifest", objectMapper.writeValueAsString(List.of(item)))
                        .header("Authorization", author))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("POST_IMPORT_INVALID"));

        // An ADMIN is exempt, and a file with as many tags as a post may have is fine for an author.
        assertThat(previewOf(auth.bearerForAdmin(), markdown(text))
                        .path("state")
                        .asString())
                .isEqualTo("new");
        String two = text.replace(", gamma-" + suffix, "");
        assertThat(previewOf(author, markdown(two)).path("state").asString()).isEqualTo("new");
    }

    @Test
    void the_preview_of_an_update_refuses_a_file_that_adds_a_tag_over_the_limit_and_allows_one_that_adds_none()
            throws Exception {
        Author author = newAuthorAccount();
        UUID first = newTag();
        UUID second = newTag();
        UUID third = newTag();
        // A post that already carries three tags (an administrator tagged it, or the limit was higher when it was
        // written).
        UUID postId = created(createPost(author.bearer(), "Already tagged", List.of(first, second)));
        jdbcTemplate.update("INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)", postId, third);
        String slug = jdbcTemplate.queryForObject("SELECT slug FROM posts WHERE id = ?", String.class, postId);
        List<String> names = jdbcTemplate.queryForList(
                "SELECT name FROM tags WHERE id IN (?, ?, ?) ORDER BY name", String.class, first, second, third);
        String same = """
                ---
                slug: %s
                title: Retitled
                tags: %s
                ---

                A new body.
                """.formatted(slug, String.join(", ", names));
        String more = same.replace(
                "tags: ", "tags: one-more-" + UUID.randomUUID().toString().substring(0, 8) + ", ");

        // Keeping the tags it has is no growth, whatever their number: the limit stops growth and never locks a post.
        assertThat(previewOf(author.bearer(), markdown(same)).path("state").asString())
                .isEqualTo("will_change");
        // A fourth tag is growth over the limit.
        JsonNode grown = previewOf(author.bearer(), markdown(more));
        assertThat(grown.path("state").asString()).isEqualTo("error");
        assertThat(hasTagLimitProblem(grown)).isTrue();
    }

    @Test
    void an_author_creates_a_few_tags_and_categories_an_hour_and_an_admin_is_not_counted() throws Exception {
        String author = newAuthor();
        for (int i = 0; i < 2; i++) {
            mockMvc.perform(post("/api/v1/admin/tags")
                            .header("Authorization", author)
                            .contentType(APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(Map.of("name", "Burst tag " + UUID.randomUUID()))))
                    .andExpect(status().isCreated());
        }

        // Tags and categories share the one bucket of the author.
        mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", author)
                        .contentType(APPLICATION_JSON)
                        .content(
                                objectMapper.writeValueAsString(Map.of("name", "Burst category " + UUID.randomUUID()))))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.error.code").value("RATE_LIMITED"));

        String admin = auth.bearerForAdmin();
        for (int i = 0; i < 4; i++) {
            mockMvc.perform(post("/api/v1/admin/tags")
                            .header("Authorization", admin)
                            .contentType(APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(Map.of("name", "Admin tag " + UUID.randomUUID()))))
                    .andExpect(status().isCreated());
        }
    }

    @Test
    void a_full_catalog_stops_an_author_creating_a_tag_or_a_category_and_not_an_admin() throws Exception {
        // The catalog is filled up to its limit, so the rows added here are removed again: the other tests of this
        // class share the
        // database and need room for their own tags and categories, whatever the order the tests run in.
        List<UUID> tagsBefore = jdbcTemplate.queryForList("SELECT id FROM tags", UUID.class);
        List<UUID> categoriesBefore = jdbcTemplate.queryForList("SELECT id FROM categories", UUID.class);
        try {
            Long tags = jdbcTemplate.queryForObject("SELECT count(*) FROM tags", Long.class);
            for (long i = tags; i < 20; i++) {
                newTag();
            }
            Long categories = jdbcTemplate.queryForObject("SELECT count(*) FROM categories", Long.class);
            for (long i = categories; i < 5; i++) {
                UUID id = UUID.randomUUID();
                jdbcTemplate.update(
                        "INSERT INTO categories (id, name, slug) VALUES (?, ?, ?)", id, "Full " + id, "full-" + id);
            }
            String author = newAuthor();

            mockMvc.perform(post("/api/v1/admin/tags")
                            .header("Authorization", author)
                            .contentType(APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(Map.of("name", "No room " + UUID.randomUUID()))))
                    .andExpect(status().isUnprocessableContent())
                    .andExpect(jsonPath("$.error.code").value("AUTHOR_QUOTA_EXCEEDED"));
            mockMvc.perform(post("/api/v1/admin/categories")
                            .header("Authorization", newAuthor())
                            .contentType(APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(Map.of("name", "No room " + UUID.randomUUID()))))
                    .andExpect(status().isUnprocessableContent())
                    .andExpect(jsonPath("$.error.code").value("AUTHOR_QUOTA_EXCEEDED"));

            mockMvc.perform(post("/api/v1/admin/tags")
                            .header("Authorization", auth.bearerForAdmin())
                            .contentType(APPLICATION_JSON)
                            .content(
                                    objectMapper.writeValueAsString(Map.of("name", "Admin room " + UUID.randomUUID()))))
                    .andExpect(status().isCreated());
        } finally {
            removeAddedSince("tags", tagsBefore);
            removeAddedSince("categories", categoriesBefore);
        }
    }

    /** Deletes the rows of {@code table} that are not in {@code before}: only the rows a test added, nothing else uses them. */
    private void removeAddedSince(String table, List<UUID> before) {
        for (UUID id : jdbcTemplate.queryForList("SELECT id FROM " + table, UUID.class)) {
            if (!before.contains(id)) {
                jdbcTemplate.update("DELETE FROM " + table + " WHERE id = ?", id);
            }
        }
    }

    @Test
    void a_post_holds_a_limited_number_of_body_images_for_an_author_and_not_for_an_admin() throws Exception {
        String author = newAuthor();
        UUID mine = created(createPost(author, "With images", List.of()));
        for (int i = 0; i < 2; i++) {
            mockMvc.perform(image(POSTS + "/" + mine + "/images", author)).andExpect(status().isOk());
        }

        mockMvc.perform(image(POSTS + "/" + mine + "/images", author))
                .andExpect(status().isUnprocessableContent())
                .andExpect(jsonPath("$.error.code").value("AUTHOR_QUOTA_EXCEEDED"));

        String admin = auth.bearerForAdmin();
        UUID theirs = created(createPost(admin, "Admin with images", List.of()));
        for (int i = 0; i < 3; i++) {
            mockMvc.perform(image(POSTS + "/" + theirs + "/images", admin)).andExpect(status().isOk());
        }
    }

    @Test
    void an_author_over_their_share_of_the_media_quota_is_refused_while_the_site_has_room_and_an_admin_is_not()
            throws Exception {
        Author account = newAuthorAccount();
        String author = account.bearer();
        UUID mine = created(createPost(author, "Cover share", List.of()));
        // The author already holds 3000 bytes of images; the share is 2 KB. Written with SQL, as an old upload would
        // be.
        UUID media = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO media (id, content_type, width, height, byte_size, sha256, uploaded_by) VALUES (?, 'image/png', 1, 1, 3000, ?, ?)",
                media,
                "ab".repeat(32),
                account.id());
        jdbcTemplate.update("INSERT INTO media_content (media_id, data) VALUES (?, ?)", media, new byte[3000]);

        mockMvc.perform(image(POSTS + "/" + mine + "/images", author))
                .andExpect(status().isUnprocessableContent())
                .andExpect(jsonPath("$.error.code").value("MEDIA_QUOTA_EXCEEDED"));
        mockMvc.perform(cover(POSTS + "/" + mine + "/cover", author))
                .andExpect(status().isUnprocessableContent())
                .andExpect(jsonPath("$.error.code").value("MEDIA_QUOTA_EXCEEDED"));

        String admin = auth.bearerForAdmin();
        UUID theirs = created(createPost(admin, "Admin cover", List.of()));
        mockMvc.perform(cover(POSTS + "/" + theirs + "/cover", admin)).andExpect(status().isOk());
    }

    private static RequestBuilder image(String url, String bearer) throws IOException {
        return upload(url, bearer);
    }

    private static RequestBuilder cover(String url, String bearer) throws IOException {
        return upload(url, bearer);
    }

    private static RequestBuilder upload(String url, String bearer) throws IOException {
        byte[] png;
        try (InputStream in = AuthorQuotaIT.class.getResourceAsStream("/media/opaque.png")) {
            png = Objects.requireNonNull(in).readAllBytes();
        }
        return multipart(url)
                .file(new MockMultipartFile("file", "opaque.png", "image/png", png))
                .header("Authorization", bearer);
    }
}
