package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Translations of a post: the language of a post, the admin endpoints that create, link, list and unlink the posts of
 * one article, what a reader can see of them, and the {@code lang} filter of the public lists.
 *
 * Every public assertion has a control (the sibling IS visible once published), so a draft that "stays hidden" is not
 * just a broken endpoint. Real tokens through the real filter chain, like PostOwnershipIT.
 */
@AutoConfigureMockMvc
class PostTranslationIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String admin;
    private String alice;
    private String bob;
    private UUID category;
    private String marker;

    @BeforeEach
    void seed() throws Exception {
        admin = auth.bearerForAdmin();
        alice = auth.bearerFor(auth.createAuthor("alice-" + UUID.randomUUID() + "@blog.local"));
        bob = auth.bearerFor(auth.createAuthor("bob-" + UUID.randomUUID() + "@blog.local"));
        category = UUID.fromString(data(mockMvc.perform(post("/api/v1/admin/categories")
                                .header("Authorization", admin)
                                .contentType(APPLICATION_JSON)
                                .content("{\"name\":\"Category " + UUID.randomUUID() + "\"}"))
                        .andExpect(status().isCreated()))
                .path("id")
                .asString());
        marker = word();
    }

    // ---------------------------------------------------------------- create a translation draft

    @Test
    void a_translation_draft_copies_the_post_links_the_group_and_is_public_only_after_it_is_published()
            throws Exception {
        UUID tag = createTag();
        UUID source = createPost(alice, "Source " + marker, "vi", tag);
        publish(alice, source);
        String sourceSlug = slugOf(source);

        JsonNode draft = data(createTranslation(alice, source, "en", null).andExpect(status().isCreated()));
        UUID translation = UUID.fromString(draft.path("id").asString());
        assertThat(draft.path("language").asString()).isEqualTo("en");
        assertThat(draft.path("status").asString()).isEqualTo("DRAFT");
        assertThat(draft.path("content").asString()).isEmpty();
        assertThat(draft.path("title").asString()).isEqualTo("Source " + marker);
        assertThat(draft.path("slug").asString()).isEqualTo(sourceSlug + "-en");
        assertThat(draft.path("category").path("id").asString()).isEqualTo(category.toString());
        assertThat(draft.path("tags").get(0).path("id").asString()).isEqualTo(tag.toString());
        assertThat(groupOf(translation)).isNotNull().isEqualTo(groupOf(source));

        // Control and the point of the test: while it is a draft the source shows no sibling.
        mockMvc.perform(get("/api/v1/posts/" + sourceSlug))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.translations.length()").value(0));
        mockMvc.perform(get("/api/v1/posts/" + sourceSlug + "-en")).andExpect(status().isNotFound());

        update(alice, translation, "Translated " + marker, "Some English text", "en");
        publish(alice, translation);

        mockMvc.perform(get("/api/v1/posts/" + sourceSlug))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.translations.length()").value(1))
                .andExpect(jsonPath("$.data.translations[0].language").value("en"))
                .andExpect(jsonPath("$.data.translations[0].slug").value(sourceSlug + "-en"))
                .andExpect(jsonPath("$.data.translations[0].status").value("PUBLISHED"));
        mockMvc.perform(get("/api/v1/posts/" + sourceSlug + "-en"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.translations[0].language").value("vi"))
                .andExpect(jsonPath("$.data.translations[0].slug").value(sourceSlug));
    }

    @Test
    void only_an_admin_translation_draft_joins_the_series_of_the_source_after_its_last_part() throws Exception {
        UUID source = createPost(alice, "Series source " + marker, "vi", null);
        UUID other = createPost(alice, "Series other " + marker, "vi", null);
        UUID third = createPost(alice, "Series third " + marker, "vi", null);
        UUID series = UUID.fromString(data(mockMvc.perform(post("/api/v1/admin/series")
                                .header("Authorization", admin)
                                .contentType(APPLICATION_JSON)
                                .content("{\"title\":\"Series " + UUID.randomUUID() + "\"}"))
                        .andExpect(status().isCreated()))
                .path("id")
                .asString());
        mockMvc.perform(put("/api/v1/admin/series/" + series + "/posts")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"postIds\":[\"" + source + "\",\"" + other + "\",\"" + third + "\"]}"))
                .andExpect(status().isOk());

        // Series membership is an ADMIN decision: an AUTHOR's draft stays out of the series.
        UUID byAuthor = UUID.fromString(
                data(createTranslation(alice, source, "en", null).andExpect(status().isCreated()))
                        .path("id")
                        .asString());
        assertThat(jdbcTemplate
                        .queryForMap("SELECT series_id FROM posts WHERE id = ?", byAuthor)
                        .get("series_id"))
                .isNull();

        UUID byAdmin =
                UUID.fromString(data(createTranslation(admin, third, "en", null).andExpect(status().isCreated()))
                        .path("id")
                        .asString());
        Map<String, Object> row =
                jdbcTemplate.queryForMap("SELECT series_id, series_position FROM posts WHERE id = ?", byAdmin);
        assertThat(row.get("series_id")).isEqualTo(series);
        assertThat(row.get("series_position")).isEqualTo(4);
    }

    @Test
    void an_author_cannot_change_a_group_that_an_admin_made_from_posts_of_several_authors() throws Exception {
        UUID aliceVi = createPost(alice, "Mixed alice " + marker, "vi", null);
        UUID bobEn = createPost(bob, "Mixed bob " + marker, "en", null);
        UUID aliceOther = createPost(alice, "Mixed other " + marker, "vi", null);
        mockMvc.perform(put(translations(aliceVi) + "/" + bobEn).header("Authorization", admin))
                .andExpect(status().isOk());
        UUID group = groupOf(aliceVi);

        // Neither joining, creating a draft in, nor leaving the group is allowed to alice: part of it is bob's.
        link(alice, aliceOther, aliceVi).andExpect(status().isForbidden());
        createTranslation(alice, aliceVi, "en", null).andExpect(status().isForbidden());
        mockMvc.perform(delete(translations(aliceVi)).header("Authorization", alice))
                .andExpect(status().isForbidden());
        assertThat(groupOf(aliceVi)).isEqualTo(group);
        assertThat(groupOf(bobEn)).isEqualTo(group);
        assertThat(groupOf(aliceOther)).isNull();

        // The admin can, and an author can still manage a group that is entirely theirs.
        mockMvc.perform(delete(translations(aliceVi)).header("Authorization", admin))
                .andExpect(status().isNoContent());
        assertThat(groupOf(bobEn)).isNull();
        UUID aliceEn = createPost(alice, "Own en " + marker, "en", null);
        link(alice, aliceOther, aliceEn).andExpect(status().isOk());
        assertThat(groupOf(aliceOther)).isNotNull().isEqualTo(groupOf(aliceEn));
    }

    @Test
    void the_slug_of_a_translation_is_taken_as_given_or_made_unique_and_a_taken_slug_is_a_409() throws Exception {
        UUID source = createPost(alice, "Slug source " + marker, "vi", null);
        UUID blocker = createPost(bob, "Blocker " + marker, "vi", null);

        String requested = "chosen-" + marker;
        JsonNode created =
                data(createTranslation(alice, source, "en", requested).andExpect(status().isCreated()));
        assertThat(created.path("slug").asString()).isEqualTo(requested);

        // Taken by a post; the request is slugified first, so another spelling of the slug is the same slug.
        UUID second = createPost(alice, "Second source " + marker, "vi", null);
        createTranslation(alice, second, "en", "Chosen " + marker.toUpperCase())
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("RESOURCE_CONFLICT"))
                .andExpect(jsonPath("$.error.message").value(org.hamcrest.Matchers.containsString(requested)));

        // Taken by the old slug of a post that moved.
        publish(bob, blocker);
        String oldSlug = slugOf(blocker);
        update(bob, blocker, "Blocker " + marker, "text", null, "moved-" + marker);
        createTranslation(alice, second, "en", oldSlug)
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("RESOURCE_CONFLICT"));

        // Without a requested slug the default is made unique instead of failing.
        UUID taken = createPost(alice, "Taken " + marker, "vi", null);
        String takenDefault = slugOf(taken) + "-en";
        createPost(bob, "Squatter " + marker, "en", null, takenDefault);
        JsonNode unique = data(createTranslation(alice, taken, "en", null).andExpect(status().isCreated()));
        assertThat(unique.path("slug").asString()).isEqualTo(takenDefault + "-2");
    }

    @Test
    void an_invalid_language_is_a_400_and_the_language_of_the_post_or_of_its_group_is_a_409() throws Exception {
        UUID source = createPost(alice, "Languages " + marker, "vi", null);

        createTranslation(alice, source, "fr", null)
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        createTranslation(alice, source, "vi", null)
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("TRANSLATION_CONFLICT"));

        createTranslation(alice, source, "en", null).andExpect(status().isCreated());
        createTranslation(alice, source, "en", null)
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("TRANSLATION_CONFLICT"));
        // Counted once: the failed attempt left no extra post behind.
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM posts WHERE translation_group_id = ?", Integer.class, groupOf(source)))
                .isEqualTo(2);
    }

    // ---------------------------------------------------------------- what the public sees

    @Test
    void a_draft_or_unpublished_sibling_is_in_no_public_response_and_returns_when_published_again() throws Exception {
        UUID vi = createPost(alice, "Public " + marker, "vi", null);
        publish(alice, vi);
        UUID en = UUID.fromString(data(createTranslation(alice, vi, "en", null).andExpect(status().isCreated()))
                .path("id")
                .asString());
        String enSlug = slugOf(en);

        assertNotPublic(enSlug, vi);

        update(alice, en, "Public english " + marker, "text", "en");
        publish(alice, en);
        mockMvc.perform(get("/api/v1/posts/" + enSlug)).andExpect(status().isOk());
        assertThat(listSlugs("/api/v1/posts?lang=en&size=50")).contains(enSlug);
        assertThat(searchSlugs(marker, "en")).contains(enSlug);
        assertThat(translationLanguagesOf(slugOf(vi))).containsExactly("en");

        unpublish(alice, en);
        // The membership stays (nothing is lost), the unpublished post is just not exposed.
        assertThat(groupOf(en)).isNotNull().isEqualTo(groupOf(vi));
        assertNotPublic(enSlug, vi);

        publish(alice, en);
        assertThat(translationLanguagesOf(slugOf(vi))).containsExactly("en");
    }

    private void assertNotPublic(String siblingSlug, UUID source) throws Exception {
        mockMvc.perform(get("/api/v1/posts/" + siblingSlug)).andExpect(status().isNotFound());
        assertThat(listSlugs("/api/v1/posts?size=50")).doesNotContain(siblingSlug);
        assertThat(listSlugs("/api/v1/posts?lang=en&size=50")).doesNotContain(siblingSlug);
        assertThat(searchSlugs(marker, null)).doesNotContain(siblingSlug);
        assertThat(searchSlugs(marker, "en")).doesNotContain(siblingSlug);
        assertThat(translationLanguagesOf(slugOf(source))).isEmpty();
        // The sibling's title is not even a substring of the source response.
        String body = mockMvc.perform(get("/api/v1/posts/" + slugOf(source)))
                .andReturn()
                .getResponse()
                .getContentAsString();
        assertThat(body).doesNotContain(siblingSlug);
    }

    // ---------------------------------------------------------------- authorization

    @Test
    void an_author_cannot_list_create_link_or_unlink_translations_of_someone_elses_post() throws Exception {
        UUID aliceViPost = createPost(alice, "Alice vi " + marker, "vi", null);
        UUID bobEnPost = createPost(bob, "Bob en " + marker, "en", null);
        UUID bobViPost = createPost(bob, "Bob vi " + marker, "vi", null);

        mockMvc.perform(get(translations(aliceViPost)).header("Authorization", bob))
                .andExpect(status().isForbidden());
        createTranslation(bob, aliceViPost, "en", null).andExpect(status().isForbidden());
        // Both posts must be the caller's: own post + someone else's, in either direction.
        mockMvc.perform(put(translations(aliceViPost) + "/" + bobEnPost).header("Authorization", alice))
                .andExpect(status().isForbidden());
        mockMvc.perform(put(translations(aliceViPost) + "/" + bobEnPost).header("Authorization", bob))
                .andExpect(status().isForbidden());
        mockMvc.perform(put(translations(bobEnPost) + "/" + aliceViPost).header("Authorization", bob))
                .andExpect(status().isForbidden());
        mockMvc.perform(delete(translations(aliceViPost)).header("Authorization", bob))
                .andExpect(status().isForbidden());

        // Nothing moved, and an author can still link two of their own posts (control).
        assertThat(groupOf(aliceViPost)).isNull();
        assertThat(groupOf(bobEnPost)).isNull();
        mockMvc.perform(put(translations(bobViPost) + "/" + bobEnPost).header("Authorization", bob))
                .andExpect(status().isOk());
        assertThat(groupOf(bobViPost)).isNotNull().isEqualTo(groupOf(bobEnPost));
    }

    @Test
    void an_author_never_sees_the_draft_of_another_author_among_the_translations_but_an_admin_does() throws Exception {
        UUID aliceViPost = createPost(alice, "Alice vi " + marker, "vi", null);
        UUID bobEnPost = createPost(bob, "Bob en " + marker, "en", null);
        mockMvc.perform(put(translations(aliceViPost) + "/" + bobEnPost).header("Authorization", admin))
                .andExpect(status().isOk());

        assertThat(adminTranslationStatuses(admin, aliceViPost)).containsExactly("en:DRAFT");
        assertThat(adminTranslationStatuses(alice, aliceViPost)).isEmpty();

        update(bob, bobEnPost, "Bob en " + marker, "text", null);
        publish(bob, bobEnPost);
        assertThat(adminTranslationStatuses(alice, aliceViPost)).containsExactly("en:PUBLISHED");
    }

    @Test
    void an_admin_can_link_the_posts_of_two_authors_and_the_link_is_symmetric_and_idempotent() throws Exception {
        UUID aliceViPost = createPost(alice, "Alice vi " + marker, "vi", null);
        UUID bobEnPost = createPost(bob, "Bob en " + marker, "en", null);

        mockMvc.perform(put(translations(aliceViPost) + "/" + bobEnPost).header("Authorization", admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value(aliceViPost.toString()));
        mockMvc.perform(put(translations(bobEnPost) + "/" + aliceViPost).header("Authorization", admin))
                .andExpect(status().isOk());

        UUID group = groupOf(aliceViPost);
        assertThat(group).isNotNull().isEqualTo(groupOf(bobEnPost));
        assertThat(adminTranslationStatuses(admin, bobEnPost)).containsExactly("vi:DRAFT");
        assertThat(adminTranslationStatuses(admin, aliceViPost)).containsExactly("en:DRAFT");
    }

    // ---------------------------------------------------------------- conflicts, unlink, delete

    @Test
    void linking_posts_of_the_same_language_or_of_two_groups_or_into_a_group_that_has_the_language_is_a_409()
            throws Exception {
        UUID vi = createPost(alice, "Vi " + marker, "vi", null);
        UUID en = createPost(alice, "En " + marker, "en", null);
        UUID otherVi = createPost(alice, "Other vi " + marker, "vi", null);
        UUID otherEn = createPost(alice, "Other en " + marker, "en", null);

        link(alice, vi, otherVi).andExpect(status().isConflict()).andExpect(conflictCode());
        link(alice, vi, vi).andExpect(status().isBadRequest());

        link(alice, vi, en).andExpect(status().isOk());
        // The group {vi, en} has both languages already.
        link(alice, vi, otherEn).andExpect(status().isConflict()).andExpect(conflictCode());
        link(alice, otherVi, en).andExpect(status().isConflict()).andExpect(conflictCode());

        // Two different groups.
        link(alice, otherVi, otherEn).andExpect(status().isOk());
        link(alice, vi, otherEn).andExpect(status().isConflict()).andExpect(conflictCode());
        link(alice, en, otherVi).andExpect(status().isConflict()).andExpect(conflictCode());
        assertThat(groupOf(vi)).isNotEqualTo(groupOf(otherVi));

        // Linking the same pair again is not an error.
        link(alice, vi, en).andExpect(status().isOk());
    }

    @Test
    void a_missing_post_is_404_for_an_admin() throws Exception {
        UUID vi = createPost(alice, "Vi " + marker, "vi", null);
        mockMvc.perform(put(translations(vi) + "/" + UUID.randomUUID()).header("Authorization", admin))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("POST_NOT_FOUND"));
    }

    @Test
    void unlinking_one_post_dissolves_a_pair_and_is_idempotent() throws Exception {
        UUID vi = createPost(alice, "Vi " + marker, "vi", null);
        UUID en = createPost(alice, "En " + marker, "en", null);
        link(alice, vi, en).andExpect(status().isOk());

        mockMvc.perform(delete(translations(en)).header("Authorization", alice)).andExpect(status().isNoContent());

        assertThat(groupOf(en)).isNull();
        assertThat(groupOf(vi)).isNull();
        assertThat(adminTranslationStatuses(alice, vi)).isEmpty();
        mockMvc.perform(delete(translations(en)).header("Authorization", alice)).andExpect(status().isNoContent());
        // Control: they can be linked again, so nothing is left half-linked.
        link(alice, vi, en).andExpect(status().isOk());
    }

    @Test
    void deleting_one_translation_leaves_the_other_untouched_and_ungrouped() throws Exception {
        UUID vi = createPost(alice, "Vi " + marker, "vi", null);
        publish(alice, vi);
        UUID en = UUID.fromString(data(createTranslation(alice, vi, "en", null).andExpect(status().isCreated()))
                .path("id")
                .asString());
        Object updatedBefore =
                jdbcTemplate.queryForObject("SELECT updated_at FROM posts WHERE id = ?", Object.class, vi);

        mockMvc.perform(delete("/api/v1/admin/posts/" + en).header("Authorization", alice))
                .andExpect(status().isNoContent());

        assertThat(groupOf(vi)).isNull();
        // The deleted post itself is out of the group too: an author's delete only hides it, and a hidden post must not
        // keep
        // the language of the sibling taken.
        assertThat(groupOf(en)).isNull();
        assertThat(jdbcTemplate.queryForObject("SELECT status FROM posts WHERE id = ?", String.class, vi))
                .isEqualTo("PUBLISHED");
        assertThat(jdbcTemplate.queryForObject("SELECT updated_at FROM posts WHERE id = ?", Object.class, vi))
                .isEqualTo(updatedBefore);
        mockMvc.perform(get("/api/v1/posts/" + slugOf(vi)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.translations.length()").value(0));
    }

    // ---------------------------------------------------------------- language of a post

    @Test
    void changing_the_language_inside_a_group_to_the_language_of_the_sibling_is_a_409() throws Exception {
        UUID vi = createPost(alice, "Vi " + marker, "vi", null);
        UUID en = createPost(alice, "En " + marker, "en", null);
        link(alice, vi, en).andExpect(status().isOk());

        mockMvc.perform(put("/api/v1/admin/posts/" + en)
                        .header("Authorization", alice)
                        .contentType(APPLICATION_JSON)
                        .content(updateBody("En " + marker, "text", "vi", null)))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("TRANSLATION_CONFLICT"));
        assertThat(jdbcTemplate.queryForObject("SELECT language FROM posts WHERE id = ?", String.class, en))
                .isEqualTo("en");
    }

    @Test
    void the_old_slug_of_a_post_still_redirects_after_its_language_and_slug_change() throws Exception {
        UUID id = createPost(alice, "Moving " + marker, "vi", null);
        publish(alice, id);
        String oldSlug = slugOf(id);

        update(alice, id, "Moving " + marker, "text", "en", "moved-" + marker);

        assertThat(jdbcTemplate.queryForObject("SELECT language FROM posts WHERE id = ?", String.class, id))
                .isEqualTo("en");
        mockMvc.perform(get("/api/v1/posts/" + oldSlug + "/redirect"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.slug").value("moved-" + marker));
        mockMvc.perform(get("/api/v1/posts/moved-" + marker))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.language").value("en"));
    }

    // ---------------------------------------------------------------- the lang filter

    @Test
    void the_lang_filter_selects_one_language_on_the_list_the_popular_list_and_search_and_absent_means_all()
            throws Exception {
        UUID vi = createPost(alice, "Filter " + marker, "vi", null);
        UUID en = createPost(alice, "Filter " + marker, "en", null);
        publish(alice, vi);
        publish(alice, en);
        String viSlug = slugOf(vi);
        String enSlug = slugOf(en);
        // Views far above any other test's, so both are on the first page of the popular list.
        jdbcTemplate.update("INSERT INTO post_views (post_id, view_count) VALUES (?, 4000000000000)", vi);
        jdbcTemplate.update("INSERT INTO post_views (post_id, view_count) VALUES (?, 4000000000001)", en);

        assertThat(listSlugs("/api/v1/posts?lang=en&size=50")).contains(enSlug).doesNotContain(viSlug);
        assertThat(listSlugs("/api/v1/posts?lang=vi&size=50")).contains(viSlug).doesNotContain(enSlug);
        assertThat(listSlugs("/api/v1/posts?size=50")).contains(viSlug, enSlug);
        assertThat(listSlugs("/api/v1/posts?lang=&size=50")).contains(viSlug, enSlug);

        assertThat(listSlugs("/api/v1/posts?sort=popular&lang=en&size=50"))
                .contains(enSlug)
                .doesNotContain(viSlug);
        assertThat(listSlugs("/api/v1/posts?sort=popular&lang=vi&size=50"))
                .contains(viSlug)
                .doesNotContain(enSlug);
        assertThat(listSlugs("/api/v1/posts?sort=popular&size=50")).contains(viSlug, enSlug);
        mockMvc.perform(get("/api/v1/posts?sort=popular&lang=en&size=1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].language").value("en"));

        assertThat(searchSlugs(marker, "en")).containsExactly(enSlug);
        assertThat(searchSlugs(marker, "vi")).containsExactly(viSlug);
        assertThat(searchSlugs(marker, null)).containsExactlyInAnyOrder(viSlug, enSlug);
        // The total of the page follows the filter, not the unfiltered set.
        mockMvc.perform(get("/api/v1/posts/search?q=" + marker + "&lang=en"))
                .andExpect(jsonPath("$.pagination.totalElements").value(1));
    }

    @Test
    void an_unknown_lang_is_a_400_on_every_public_post_list() throws Exception {
        for (String url : List.of(
                "/api/v1/posts?lang=xx", "/api/v1/posts?lang=xx&sort=popular", "/api/v1/posts/search?q=abc&lang=xx")) {
            mockMvc.perform(get(url))
                    .andExpect(status().isBadRequest())
                    .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
        }
    }

    // ---------------------------------------------------------------- helpers

    private static org.springframework.test.web.servlet.ResultMatcher conflictCode() {
        return jsonPath("$.error.code").value("TRANSLATION_CONFLICT");
    }

    private static String translations(UUID id) {
        return "/api/v1/admin/posts/" + id + "/translations";
    }

    private ResultActions link(String token, UUID id, UUID otherId) throws Exception {
        return mockMvc.perform(put(translations(id) + "/" + otherId).header("Authorization", token));
    }

    private ResultActions createTranslation(String token, UUID id, String language, String slug) throws Exception {
        String body = slug == null
                ? "{\"language\":\"" + language + "\"}"
                : "{\"language\":\"" + language + "\",\"slug\":\"" + slug + "\"}";
        return mockMvc.perform(post(translations(id))
                .header("Authorization", token)
                .contentType(APPLICATION_JSON)
                .content(body));
    }

    /** {@code "<language>:<status>"} of every translation the caller sees on the admin endpoint. */
    private List<String> adminTranslationStatuses(String token, UUID id) throws Exception {
        JsonNode list = data(mockMvc.perform(get(translations(id)).header("Authorization", token))
                .andExpect(status().isOk()));
        List<String> result = new ArrayList<>();
        list.forEach(node -> result.add(
                node.path("language").asString() + ":" + node.path("status").asString()));
        return result;
    }

    private List<String> translationLanguagesOf(String slug) throws Exception {
        JsonNode list = data(mockMvc.perform(get("/api/v1/posts/" + slug)).andExpect(status().isOk()))
                .path("translations");
        List<String> result = new ArrayList<>();
        list.forEach(node -> result.add(node.path("language").asString()));
        return result;
    }

    private List<String> listSlugs(String url) throws Exception {
        return slugsOf(mockMvc.perform(get(url)).andExpect(status().isOk()));
    }

    private List<String> searchSlugs(String query, String language) throws Exception {
        String url = "/api/v1/posts/search?q=" + query + (language == null ? "" : "&lang=" + language);
        return listSlugs(url);
    }

    private List<String> slugsOf(ResultActions result) throws Exception {
        JsonNode list = objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("data");
        List<String> slugs = new ArrayList<>();
        list.forEach(node -> slugs.add(node.path("slug").asString()));
        return slugs;
    }

    private UUID groupOf(UUID postId) {
        return jdbcTemplate.queryForObject("SELECT translation_group_id FROM posts WHERE id = ?", UUID.class, postId);
    }

    private String slugOf(UUID postId) throws Exception {
        return data(mockMvc.perform(get("/api/v1/admin/posts/" + postId).header("Authorization", admin))
                        .andExpect(status().isOk()))
                .path("slug")
                .asString();
    }

    private void publish(String token, UUID id) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + id + "/publish").header("Authorization", token))
                .andExpect(status().isOk());
    }

    private void unpublish(String token, UUID id) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + id + "/unpublish").header("Authorization", token))
                .andExpect(status().isOk());
    }

    private void update(String token, UUID id, String title, String content, String language) throws Exception {
        update(token, id, title, content, language, null);
    }

    private void update(String token, UUID id, String title, String content, String language, String slug)
            throws Exception {
        mockMvc.perform(put("/api/v1/admin/posts/" + id)
                        .header("Authorization", token)
                        .contentType(APPLICATION_JSON)
                        .content(updateBody(title, content, language, slug)))
                .andExpect(status().isOk());
    }

    private String updateBody(String title, String content, String language, String slug) {
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("title", title);
        body.put("content", content);
        body.put("categoryId", category.toString());
        if (language != null) {
            body.put("language", language);
        }
        if (slug != null) {
            body.put("slug", slug);
        }
        return objectMapper.writeValueAsString(body);
    }

    private UUID createPost(String token, String title, String language, UUID tag) throws Exception {
        return createPost(token, title, language, tag, null);
    }

    private UUID createPost(String token, String title, String language, UUID tag, String slug) throws Exception {
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("title", title);
        body.put("content", "text " + title);
        body.put("categoryId", category.toString());
        body.put("language", language);
        if (tag != null) {
            body.put("tagIds", List.of(tag.toString()));
        }
        if (slug != null) {
            body.put("slug", slug);
        }
        return UUID.fromString(data(mockMvc.perform(post("/api/v1/admin/posts")
                                .header("Authorization", token)
                                .contentType(APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(body)))
                        .andExpect(status().isCreated()))
                .path("id")
                .asString());
    }

    private UUID createTag() throws Exception {
        return UUID.fromString(data(mockMvc.perform(post("/api/v1/admin/tags")
                                .header("Authorization", admin)
                                .contentType(APPLICATION_JSON)
                                .content("{\"name\":\"tag" + word() + "\"}"))
                        .andExpect(status().isCreated()))
                .path("id")
                .asString());
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("data");
    }

    /** Letters only, so the full-text parser keeps it as one word and it matches nothing another test wrote. */
    private static String word() {
        StringBuilder word = new StringBuilder("zq");
        for (int i = 0; i < 10; i++) {
            word.append((char) ('a' + ThreadLocalRandom.current().nextInt(26)));
        }
        return word.toString();
    }
}
