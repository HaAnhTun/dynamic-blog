package com.blog.category.controller;

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
 * Public-facing categories: {@code GET /api/v1/categories} and {@code /api/v1/categories/{slug}}.
 *
 * The public side only sees categories with at least one PUBLISHED post: the name of a new
 * topic that only has drafts (or no post at all) is not leaked before the post goes live. For readers such a
 * category does not exist: it is not in the list, and reading by slug gives the 404 of an unknown slug. The
 * admin area sees all.
 *
 * The shared DB is never cleaned: the new tests use names with a random suffix, and the list is only checked
 * for presence or absence. Post text avoids every word that PostSearchAndFeaturedIT searches for.
 */
@AutoConfigureMockMvc
class CategoryControllerIT extends AbstractIntegrationTest {

    private static final String PUBLIC_CATEGORIES = "/api/v1/categories";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void an_author_cannot_create_a_category_whose_name_holds_a_line_break() throws Exception {
        String author = auth.bearerFor(auth.createAuthor("category-lines-" + UUID.randomUUID() + "@blog.local"));

        mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", author)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("name", "a" + (char) 10 + "b"))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test
    void createThenFetchCategoryBySlug() throws Exception {
        String payload = objectMapper.writeValueAsString(new CreatePayload("Backend", "Backend articles"));

        String created = mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.slug").value("backend"))
                .andReturn()
                .getResponse()
                .getContentAsString();
        // The public side only sees categories with a published post.
        publish(createPost(
                "Post of the Backend category",
                idOf(objectMapper.readTree(created).path("data"))));

        mockMvc.perform(get("/api/v1/categories/backend"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.name").value("Backend"));
    }

    @Test
    void fetchingUnknownSlugReturns404WithErrorEnvelope() throws Exception {
        mockMvc.perform(get("/api/v1/categories/does-not-exist"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("CATEGORY_NOT_FOUND"));
    }

    @Test
    void listReturnsCreatedCategories() throws Exception {
        String payload = objectMapper.writeValueAsString(new CreatePayload("Frontend", null));

        String created = mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        publish(createPost(
                "Post of the Frontend category",
                idOf(objectMapper.readTree(created).path("data"))));

        mockMvc.perform(get("/api/v1/categories"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[?(@.slug == 'frontend')]").exists());
    }

    @Test
    void creatingDuplicateNameReturns409AndAppearsOnlyOnceInAdminList() throws Exception {
        String payload = objectMapper.writeValueAsString(new CreatePayload("Observability", "First"));

        mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated());

        mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(new CreatePayload("observability", "Second"))))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("CATEGORY_ALREADY_EXISTS"));

        mockMvc.perform(get("/api/v1/admin/categories").header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[?(@.slug == 'observability')]").exists());
    }

    // --- Only categories with a published post -------------------------------------------------

    @Test
    void category_with_only_drafts_is_not_exposed_and_returns_the_404_of_an_unknown_slug() throws Exception {
        Created category = createCategory("Upcoming Topic");
        createPost("Unpublished post of the upcoming topic", category.id());

        assertHiddenPublicly(category);
        // The answer is identical to a nonexistent slug (except the slug in the message), so no name being
        // drafted can be probed.
        JsonNode draftOnly = error(mockMvc.perform(get(PUBLIC_CATEGORIES + "/" + category.slug())));
        JsonNode unknown = error(mockMvc.perform(get(PUBLIC_CATEGORIES + "/khong-co-" + category.slug())));
        assertThat(draftOnly.path("message").asString())
                .isEqualTo(unknown.path("message").asString().replace("khong-co-" + category.slug(), category.slug()));
        // The post filter by that slug: an empty page, as with an unknown slug.
        assertThat(publicPosts(category.slug())).isEmpty();
        // The admin area still sees it: the post editor must be able to pick it.
        assertThat(idsOf(adminList())).contains(category.id().toString());
    }

    @Test
    void category_without_any_post_is_not_shown_either() throws Exception {
        Created category = createCategory("No Posts Yet");

        assertHiddenPublicly(category);
        assertThat(idsOf(adminList())).contains(category.id().toString());
    }

    @Test
    void category_shows_with_a_published_post_and_hides_again_when_the_last_one_is_unpublished_or_archived()
            throws Exception {
        Created category = createCategory("Sometimes Visible");
        UUID post = createPost("Only post of the category", category.id());
        // An accompanying draft is never enough to make the category show.
        createPost("Accompanying unpublished post", category.id());
        assertHiddenPublicly(category);

        publish(post);
        assertVisiblePublicly(category);
        assertThat(publicPosts(category.slug())).containsExactly(post.toString());

        unpublish(post);
        assertHiddenPublicly(category);

        publish(post);
        assertVisiblePublicly(category);

        // ARCHIVED has no API path: SQL only, like CommentFixtures.archive.
        assertThat(jdbcTemplate.update("UPDATE posts SET status = 'ARCHIVED' WHERE id = ?", post))
                .isEqualTo(1);
        assertHiddenPublicly(category);
        assertThat(idsOf(adminList())).contains(category.id().toString());
    }

    // --- Languages ---------------------------------------------------------------------------------

    @Test
    void list_with_lang_only_has_categories_with_a_published_post_in_that_language_named_in_it() throws Exception {
        Created category = createCategory("Bilingual Topic");
        putTranslations(
                category.id(),
                Map.of("en", Map.of("name", "English " + category.slug(), "description", "English description")));
        UUID viPost = createPost("Vietnamese post of the bilingual topic", category.id(), "vi");
        UUID enPost = createPost("English post of the bilingual topic", category.id(), "en");
        publish(viPost);

        assertThat(idsOf(publicList("vi"))).contains(category.id().toString());
        assertThat(idsOf(publicList("en"))).doesNotContain(category.id().toString());
        // No lang: every language, base text, and never the raw translations.
        JsonNode all = entry(publicList(null), category);
        assertThat(all.path("name").asString()).doesNotStartWith("English");
        assertThat(all.has("translations")).isFalse();

        // A draft in the language is not enough; the published one is.
        assertThat(idsOf(publicList("en"))).doesNotContain(category.id().toString());
        publish(enPost);
        JsonNode english = entry(publicList("en"), category);
        assertThat(english.path("name").asString()).isEqualTo("English " + category.slug());
        assertThat(english.path("description").asString()).isEqualTo("English description");
        assertThat(english.has("translations")).isFalse();
        // Vietnamese has no translation: the base text.
        assertThat(entry(publicList("vi"), category).path("name").asString()).doesNotStartWith("English");

        unpublish(enPost);
        assertThat(idsOf(publicList("en"))).doesNotContain(category.id().toString());
    }

    @Test
    void detail_keeps_any_language_visibility_and_only_localizes_the_text() throws Exception {
        Created category = createCategory("Detail Topic");
        putTranslations(category.id(), Map.of("en", Map.of("name", "English " + category.slug())));
        publish(createPost("Only Vietnamese post of the detail topic", category.id(), "vi"));

        // No English post, yet the page can still show the fallback.
        mockMvc.perform(get(PUBLIC_CATEGORIES + "/" + category.slug()).param("lang", "en"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.name").value("English " + category.slug()))
                .andExpect(jsonPath("$.data.translations").doesNotExist());
        mockMvc.perform(get(PUBLIC_CATEGORIES + "/" + category.slug()).param("lang", "vi"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.name")
                        .value(org.hamcrest.Matchers.not(org.hamcrest.Matchers.startsWith("English"))));
    }

    @Test
    void a_category_with_only_an_unpublished_post_in_a_language_leaks_in_no_language() throws Exception {
        Created category = createCategory("Draft Language Topic");
        putTranslations(category.id(), Map.of("en", Map.of("name", "English " + category.slug())));
        createPost("Draft English post of the topic", category.id(), "en");

        assertThat(idsOf(publicList("en"))).doesNotContain(category.id().toString());
        assertThat(idsOf(publicList("vi"))).doesNotContain(category.id().toString());
        assertThat(idsOf(publicList(null))).doesNotContain(category.id().toString());
        mockMvc.perform(get(PUBLIC_CATEGORIES + "/" + category.slug()).param("lang", "en"))
                .andExpect(status().isNotFound());
    }

    @Test
    void an_unknown_lang_is_a_validation_error_on_list_and_detail() throws Exception {
        Created category = createCategory("Lang Validation Topic");
        publish(createPost("Post of the lang validation topic", category.id(), "vi"));

        mockMvc.perform(get(PUBLIC_CATEGORIES).param("lang", "fr"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        mockMvc.perform(get(PUBLIC_CATEGORIES + "/" + category.slug()).param("lang", "fr"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        // A blank lang is no filter.
        mockMvc.perform(get(PUBLIC_CATEGORIES).param("lang", "")).andExpect(status().isOk());
    }

    @Test
    void admin_translations_round_trip_are_normalised_and_replaced_only_when_present() throws Exception {
        Created category = createCategory("Admin Translations");
        Map<String, Object> translations = new HashMap<>();
        translations.put("en", Map.of("name", "  English name  ", "description", "English description"));
        translations.put("vi", Map.of("name", "  ", "description", ""));

        JsonNode updated = putTranslations(category.id(), translations);
        // Blank entries are dropped and texts are stripped.
        assertThat(updated.path("translations").has("vi")).isFalse();
        assertThat(updated.path("translations").path("en").path("name").asString())
                .isEqualTo("English name");
        assertThat(updated.path("translations").path("en").path("description").asString())
                .isEqualTo("English description");

        JsonNode listed = entry(adminList(), category);
        assertThat(listed.path("translations").path("en").path("name").asString())
                .isEqualTo("English name");
        // The base name is untouched.
        assertThat(listed.path("name").asString()).startsWith("Admin Translations");

        // Absent keeps the stored map.
        JsonNode kept = data(mockMvc.perform(put("/api/v1/admin/categories/" + category.id())
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("name", listed.path("name").asString()))))
                .andExpect(status().isOk()));
        assertThat(kept.path("translations").path("en").path("name").asString()).isEqualTo("English name");

        // An empty map clears it.
        JsonNode cleared = putTranslations(category.id(), Map.of());
        assertThat(cleared.path("translations").size()).isZero();
    }

    @Test
    void admin_translations_reject_an_unknown_locale_and_an_overlong_name() throws Exception {
        Created category = createCategory("Translation Validation");

        mockMvc.perform(put("/api/v1/admin/categories/" + category.id())
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name",
                                "Translation Validation",
                                "translations",
                                Map.of("fr", Map.of("name", "Nom"))))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        mockMvc.perform(put("/api/v1/admin/categories/" + category.id())
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of(
                                "name",
                                "Translation Validation",
                                "translations",
                                Map.of("en", Map.of("name", "x".repeat(256)))))))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        // Nothing was stored by the rejected requests.
        assertThat(entry(adminList(), category).path("translations").size()).isZero();
    }

    @Test
    void translated_names_are_not_checked_for_uniqueness() throws Exception {
        Created first = createCategory("Unique Translation A");
        Created second = createCategory("Unique Translation B");

        putTranslations(first.id(), Map.of("en", Map.of("name", "Same translated name")));
        JsonNode other = putTranslations(second.id(), Map.of("en", Map.of("name", "Same translated name")));

        assertThat(other.path("translations").path("en").path("name").asString())
                .isEqualTo("Same translated name");
    }

    // --- Checks ------------------------------------------------------------------------------------

    private void assertHiddenPublicly(Created category) throws Exception {
        assertThat(idsOf(publicList())).doesNotContain(category.id().toString());
        mockMvc.perform(get(PUBLIC_CATEGORIES + "/" + category.slug()))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("CATEGORY_NOT_FOUND"));
    }

    private void assertVisiblePublicly(Created category) throws Exception {
        assertThat(idsOf(publicList())).contains(category.id().toString());
        mockMvc.perform(get(PUBLIC_CATEGORIES + "/" + category.slug()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value(category.id().toString()));
    }

    // --- Reads -------------------------------------------------------------------------------------

    private JsonNode publicList() throws Exception {
        return data(mockMvc.perform(get(PUBLIC_CATEGORIES)).andExpect(status().isOk()));
    }

    private JsonNode publicList(String lang) throws Exception {
        return data(mockMvc.perform(get(PUBLIC_CATEGORIES).param("lang", lang == null ? "" : lang))
                .andExpect(status().isOk()));
    }

    private static JsonNode entry(JsonNode list, Created category) {
        for (JsonNode node : list) {
            if (category.id().toString().equals(node.path("id").asString())) {
                return node;
            }
        }
        throw new AssertionError("Category not in the list: " + category.id());
    }

    /** Admin update that keeps the name and replaces the translations. */
    private JsonNode putTranslations(UUID id, Map<String, ?> translations) throws Exception {
        String name = entryName(id);
        Map<String, Object> body = new HashMap<>();
        body.put("name", name);
        body.put("translations", translations);
        return data(mockMvc.perform(put("/api/v1/admin/categories/" + id)
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isOk()));
    }

    private String entryName(UUID id) throws Exception {
        for (JsonNode node : adminList()) {
            if (id.toString().equals(node.path("id").asString())) {
                return node.path("name").asString();
            }
        }
        throw new AssertionError("Category not found: " + id);
    }

    private JsonNode adminList() throws Exception {
        return data(mockMvc.perform(get("/api/v1/admin/categories").header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk()));
    }

    private List<String> publicPosts(String categorySlug) throws Exception {
        return idsOf(data(mockMvc.perform(get("/api/v1/posts").param("category", categorySlug))
                .andExpect(status().isOk())));
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

    /** A new category, name with a random suffix. */
    private Created createCategory(String stem) throws Exception {
        String name = stem + " " + UUID.randomUUID().toString().substring(0, 8);
        JsonNode created = data(mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(new CreatePayload(name, null))))
                .andExpect(status().isCreated()));
        return new Created(idOf(created), created.path("slug").asString());
    }

    /** An admin draft in the given category. */
    private UUID createPost(String title, UUID categoryId) throws Exception {
        return createPost(title, categoryId, null);
    }

    private UUID createPost(String title, UUID categoryId, String language) throws Exception {
        Map<String, Object> body = new HashMap<>();
        if (language != null) {
            body.put("language", language);
        }
        body.put("title", title + " " + UUID.randomUUID().toString().substring(0, 8));
        body.put("excerpt", "Summary");
        body.put("content", String.join(" ", Collections.nCopies(12, "word")));
        body.put("categoryId", categoryId);
        return idOf(data(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", auth.bearerForAdmin())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
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

    private record CreatePayload(String name, String description) {}
}
