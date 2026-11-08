package com.blog.tag.controller;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Public-facing tags: {@code GET /api/v1/tags} and {@code /api/v1/tags/{slug}}.
 *
 * The public side only sees tags attached to at least one PUBLISHED post, like CategoryControllerIT:
 * a tag with only drafts or attached to no post is not in the list, and reading it by slug gives exactly the
 * 404 of an unknown slug. The admin area still sees every tag.
 *
 * The shared DB is never cleaned: the new tests use names with a random suffix, and the list is only checked
 * for presence or absence. Post text avoids every word that PostSearchAndFeaturedIT searches for.
 */
@AutoConfigureMockMvc
class TagControllerIT extends AbstractIntegrationTest {

    private static final String PUBLIC_TAGS = "/api/v1/tags";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void an_author_cannot_create_a_tag_whose_name_holds_a_line_break() throws Exception {
        String author = auth.bearerFor(auth.createAuthor("tag-lines-" + UUID.randomUUID() + "@blog.local"));

        mockMvc.perform(post("/api/v1/admin/tags")
                        .header("Authorization", author)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("name", "a" + (char) 10 + "b"))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test
    void createThenFetchTagBySlug() throws Exception {
        String payload = objectMapper.writeValueAsString(new CreatePayload("Spring Boot"));

        String created = mockMvc.perform(post("/api/v1/admin/tags")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.slug").value("spring-boot"))
                .andReturn()
                .getResponse()
                .getContentAsString();
        // The public side only sees tags attached to a published post.
        publish(createPost(
                "First tagged post", idOf(objectMapper.readTree(created).path("data"))));

        mockMvc.perform(get("/api/v1/tags/spring-boot"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.name").value("Spring Boot"));
    }

    @Test
    void fetchingUnknownSlugReturns404WithErrorEnvelope() throws Exception {
        mockMvc.perform(get("/api/v1/tags/does-not-exist"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("TAG_NOT_FOUND"));
    }

    @Test
    void listReturnsCreatedTags() throws Exception {
        String payload = objectMapper.writeValueAsString(new CreatePayload("Redis"));

        String created = mockMvc.perform(post("/api/v1/admin/tags")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        publish(createPost(
                "Second tagged post", idOf(objectMapper.readTree(created).path("data"))));

        mockMvc.perform(get("/api/v1/tags"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[?(@.slug == 'redis')]").exists());
    }

    @Test
    void creatingDuplicateNameReturns409AndAppearsOnlyOnceInAdminList() throws Exception {
        String payload = objectMapper.writeValueAsString(new CreatePayload("Kubernetes"));

        mockMvc.perform(post("/api/v1/admin/tags")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated());

        mockMvc.perform(post("/api/v1/admin/tags")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(new CreatePayload("kubernetes"))))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("TAG_ALREADY_EXISTS"));

        mockMvc.perform(get("/api/v1/admin/tags").header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[?(@.slug == 'kubernetes')]").exists());
    }

    // --- Only tags with a published post -----------------------------------------------------------------

    @Test
    void tag_only_on_drafts_is_not_exposed_and_returns_the_404_of_an_unknown_slug() throws Exception {
        Created tag = createTag("Upcoming Tag");
        createPost("Unpublished post with the upcoming tag", tag.id());

        assertHiddenPublicly(tag);
        JsonNode draftOnly = error(mockMvc.perform(get(PUBLIC_TAGS + "/" + tag.slug())));
        JsonNode unknown = error(mockMvc.perform(get(PUBLIC_TAGS + "/khong-co-" + tag.slug())));
        assertThat(draftOnly.path("message").asString())
                .isEqualTo(unknown.path("message").asString().replace("khong-co-" + tag.slug(), tag.slug()));
        assertThat(publicPosts(tag.slug())).isEmpty();
        assertThat(idsOf(adminList())).contains(tag.id().toString());
    }

    @Test
    void tag_attached_to_no_post_is_not_shown_either() throws Exception {
        Created tag = createTag("No Posts Attached");

        assertHiddenPublicly(tag);
        assertThat(idsOf(adminList())).contains(tag.id().toString());
    }

    @Test
    void tag_shows_with_a_published_post_and_hides_again_when_the_last_one_is_unpublished_or_archived()
            throws Exception {
        Created tag = createTag("Sometimes Visible Tag");
        UUID post = createPost("Only tagged post", tag.id());
        createPost("Unpublished post with the same tag", tag.id());
        assertHiddenPublicly(tag);

        publish(post);
        assertVisiblePublicly(tag);
        assertThat(publicPosts(tag.slug())).containsExactly(post.toString());

        unpublish(post);
        assertHiddenPublicly(tag);

        publish(post);
        assertVisiblePublicly(tag);

        // ARCHIVED has no API path: SQL only, like CommentFixtures.archive.
        assertThat(jdbcTemplate.update("UPDATE posts SET status = 'ARCHIVED' WHERE id = ?", post))
                .isEqualTo(1);
        assertHiddenPublicly(tag);
        assertThat(idsOf(adminList())).contains(tag.id().toString());
    }

    @Test
    void one_published_post_shows_all_its_tags_and_no_other_tag() throws Exception {
        Created shown = createTag("Published Post Tag");
        Created alsoShown = createTag("Second Published Post Tag");
        Created hidden = createTag("Draft Post Tag");
        publish(createPost("Published post with two tags", shown.id(), alsoShown.id()));
        createPost("Unpublished post with one tag", hidden.id());

        assertVisiblePublicly(shown);
        assertVisiblePublicly(alsoShown);
        assertHiddenPublicly(hidden);
    }

    // --- Languages ---------------------------------------------------------------------------------

    @Test
    void list_with_lang_only_has_tags_with_a_published_post_in_that_language_named_in_it() throws Exception {
        Created tag = createTag("Bilingual Tag");
        putTranslations(tag.id(), Map.of("en", Map.of("name", "English " + tag.slug())));
        UUID viPost = createPost("vi", "Vietnamese post of the bilingual tag", tag.id());
        UUID enPost = createPost("en", "English post of the bilingual tag", tag.id());
        publish(viPost);

        assertThat(idsOf(publicList("vi"))).contains(tag.id().toString());
        assertThat(idsOf(publicList("en"))).doesNotContain(tag.id().toString());
        JsonNode all = entry(publicList(""), tag);
        assertThat(all.path("name").asString()).doesNotStartWith("English");
        assertThat(all.has("translations")).isFalse();

        publish(enPost);
        JsonNode english = entry(publicList("en"), tag);
        assertThat(english.path("name").asString()).isEqualTo("English " + tag.slug());
        assertThat(english.has("translations")).isFalse();
        assertThat(entry(publicList("vi"), tag).path("name").asString()).doesNotStartWith("English");

        unpublish(enPost);
        assertThat(idsOf(publicList("en"))).doesNotContain(tag.id().toString());
    }

    @Test
    void detail_keeps_any_language_visibility_and_only_localizes_the_name() throws Exception {
        Created tag = createTag("Detail Tag");
        putTranslations(tag.id(), Map.of("en", Map.of("name", "English " + tag.slug())));
        publish(createPost("vi", "Only Vietnamese post of the detail tag", tag.id()));

        mockMvc.perform(get(PUBLIC_TAGS + "/" + tag.slug()).param("lang", "en"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.name").value("English " + tag.slug()))
                .andExpect(jsonPath("$.data.translations").doesNotExist());
    }

    @Test
    void a_tag_with_only_an_unpublished_post_in_a_language_leaks_in_no_language() throws Exception {
        Created tag = createTag("Draft Language Tag");
        createPost("en", "Draft English post of the tag", tag.id());

        assertThat(idsOf(publicList("en"))).doesNotContain(tag.id().toString());
        assertThat(idsOf(publicList("vi"))).doesNotContain(tag.id().toString());
        mockMvc.perform(get(PUBLIC_TAGS + "/" + tag.slug()).param("lang", "en")).andExpect(status().isNotFound());
    }

    @Test
    void an_unknown_lang_is_a_validation_error_on_list_and_detail() throws Exception {
        Created tag = createTag("Lang Validation Tag");
        publish(createPost("vi", "Post of the lang validation tag", tag.id()));

        mockMvc.perform(get(PUBLIC_TAGS).param("lang", "fr"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        mockMvc.perform(get(PUBLIC_TAGS + "/" + tag.slug()).param("lang", "fr"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test
    void admin_translations_round_trip_are_normalised_and_replaced_only_when_present() throws Exception {
        Created tag = createTag("Admin Translations Tag");
        Map<String, Object> translations = new HashMap<>();
        translations.put("en", Map.of("name", "  English name  "));
        translations.put("vi", Map.of("name", " "));

        JsonNode updated = putTranslations(tag.id(), translations);
        assertThat(updated.path("translations").has("vi")).isFalse();
        assertThat(updated.path("translations").path("en").path("name").asString())
                .isEqualTo("English name");
        assertThat(entry(adminList(), tag)
                        .path("translations")
                        .path("en")
                        .path("name")
                        .asString())
                .isEqualTo("English name");

        String name = entry(adminList(), tag).path("name").asString();
        JsonNode kept = data(mockMvc.perform(put("/api/v1/admin/tags/" + tag.id())
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("name", name))))
                .andExpect(status().isOk()));
        assertThat(kept.path("translations").path("en").path("name").asString()).isEqualTo("English name");

        assertThat(putTranslations(tag.id(), Map.of()).path("translations").size())
                .isZero();
    }

    @Test
    void admin_translations_reject_an_unknown_locale_and_a_name_over_100_characters() throws Exception {
        Created tag = createTag("Translation Validation Tag");
        String name = entry(adminList(), tag).path("name").asString();

        mockMvc.perform(put("/api/v1/admin/tags/" + tag.id())
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("name", name, "translations", Map.of("fr", Map.of("name", "Nom"))))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        mockMvc.perform(put("/api/v1/admin/tags/" + tag.id())
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name", name, "translations", Map.of("en", Map.of("name", "x".repeat(101)))))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        assertThat(entry(adminList(), tag).path("translations").size()).isZero();
    }

    // --- Checks ------------------------------------------------------------------------------------

    private void assertHiddenPublicly(Created tag) throws Exception {
        assertThat(idsOf(publicList())).doesNotContain(tag.id().toString());
        mockMvc.perform(get(PUBLIC_TAGS + "/" + tag.slug()))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("TAG_NOT_FOUND"));
    }

    private void assertVisiblePublicly(Created tag) throws Exception {
        assertThat(idsOf(publicList())).contains(tag.id().toString());
        mockMvc.perform(get(PUBLIC_TAGS + "/" + tag.slug()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value(tag.id().toString()));
    }

    // --- Reads -------------------------------------------------------------------------------------

    private JsonNode publicList() throws Exception {
        return data(mockMvc.perform(get(PUBLIC_TAGS)).andExpect(status().isOk()));
    }

    private JsonNode publicList(String lang) throws Exception {
        return data(mockMvc.perform(get(PUBLIC_TAGS).param("lang", lang)).andExpect(status().isOk()));
    }

    private static JsonNode entry(JsonNode list, Created tag) {
        for (JsonNode node : list) {
            if (tag.id().toString().equals(node.path("id").asString())) {
                return node;
            }
        }
        throw new AssertionError("Tag not in the list: " + tag.id());
    }

    /** Admin update that keeps the name and replaces the translations. */
    private JsonNode putTranslations(UUID id, Map<String, ?> translations) throws Exception {
        String name = null;
        for (JsonNode node : adminList()) {
            if (id.toString().equals(node.path("id").asString())) {
                name = node.path("name").asString();
            }
        }
        Map<String, Object> body = new HashMap<>();
        body.put("name", name);
        body.put("translations", translations);
        return data(mockMvc.perform(put("/api/v1/admin/tags/" + id)
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isOk()));
    }

    private JsonNode adminList() throws Exception {
        return data(mockMvc.perform(get("/api/v1/admin/tags").header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk()));
    }

    private List<String> publicPosts(String tagSlug) throws Exception {
        return idsOf(
                data(mockMvc.perform(get("/api/v1/posts").param("tag", tagSlug)).andExpect(status().isOk())));
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("data");
    }

    private JsonNode error(ResultActions result) throws Exception {
        result.andExpect(status().isNotFound());
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("error");
    }

    private static List<String> idsOf(JsonNode array) {
        List<String> ids = new ArrayList<>();
        array.forEach(node -> ids.add(node.path("id").asString()));
        return ids;
    }

    private static UUID idOf(JsonNode node) {
        return UUID.fromString(node.path("id").asString());
    }

    // --- Ghi ---------------------------------------------------------------------------------------

    private record Created(UUID id, String slug) {}

    /** A new tag, name with a random suffix. */
    private Created createTag(String stem) throws Exception {
        String name = stem + " " + UUID.randomUUID().toString().substring(0, 8);
        JsonNode created = data(mockMvc.perform(post("/api/v1/admin/tags")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(new CreatePayload(name))))
                .andExpect(status().isCreated()));
        return new Created(idOf(created), created.path("slug").asString());
    }

    /**
     * An admin draft with the given tags attached, in a new category of its own (a post needs a category to
     * be published).
     */
    private UUID createPost(String title, UUID... tagIds) throws Exception {
        return createPost(null, title, tagIds);
    }

    private UUID createPost(String language, String title, UUID... tagIds) throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        JsonNode category = data(mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("name", "Category tags " + suffix))))
                .andExpect(status().isCreated()));
        Map<String, Object> fields = new HashMap<>();
        fields.put("title", title + " " + suffix);
        fields.put("excerpt", "Summary");
        fields.put("content", String.join(" ", Collections.nCopies(12, "word")));
        fields.put("categoryId", category.path("id").asString());
        fields.put("tagIds", List.of(tagIds));
        if (language != null) {
            fields.put("language", language);
        }
        String body = objectMapper.writeValueAsString(fields);
        return idOf(data(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isCreated())));
    }

    private void publish(UUID post) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + post + "/publish").header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk());
    }

    private void unpublish(UUID post) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + post + "/unpublish")
                        .header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk());
    }

    private record CreatePayload(String name) {}
}
