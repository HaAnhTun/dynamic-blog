package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
 * Slug history and the old-slug lookup: {@code GET /api/v1/posts/{slug}/redirect}.
 *
 * Changing the slug of a post that was ever published records the old slug ({@code post_slug_history}); the lookup returns
 * the post's CURRENT slug, so Next can issue a permanent redirect instead of a 404. The rules checked here:
 * <ul>
 *   <li>one hop: a → b → c makes both a and b point straight to c, no chain a → b → c;</li>
 *   <li>no loop: going back to an old slug revives that slug and its history row is gone;</li>
 *   <li>another post cannot take anyone's old slug (create or update), it gets a suffix as with a slug in use;</li>
 *   <li>a draft that was never published leaves nothing behind and holds no slug;</li>
 *   <li>answers only when the post is CURRENTLY published, and never returns the slug that was asked about: no draft slug leaks.</li>
 * </ul>
 *
 * No call to the lookup carries a token: it is a public read endpoint like {@code GET /api/v1/posts/{slug}}.
 * The DB is shared and never cleaned: every test slug carries a random suffix. Post text avoids every word that
 * PostSearchAndFeaturedIT searches for.
 */
@AutoConfigureMockMvc
class PostSlugHistoryIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    private String admin;
    private String suffix;
    private UUID categoryId;

    /** A post of the test; slug is the slug at creation time. */
    private record Fixture(UUID id, String slug) {}

    @BeforeEach
    void setUp() throws Exception {
        admin = auth.bearerForAdmin();
        suffix = UUID.randomUUID().toString().substring(0, 8);
        categoryId = UUID.fromString(data(mockMvc.perform(post("/api/v1/admin/categories")
                                .header("Authorization", admin)
                                .contentType(APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(Map.of("name", "Category slug " + suffix))))
                        .andExpect(status().isCreated()))
                .path("id")
                .asString());
    }

    // --- Changing the slug -----------------------------------------------------------------------

    @Test
    void changing_slug_of_published_post_points_old_slug_to_new_and_old_path_is_no_longer_a_post() throws Exception {
        Fixture post = publish(create(slug("cu")));
        // Resubmitting the current slug (the editor sends the slug on every save): changes nothing, records no history.
        assertThat(rename(post, post.slug())).isEqualTo(post.slug());
        assertThat(history(post)).isEmpty();
        assertNoRedirect(post.slug());

        String renamed = rename(post, slug("moi"));

        assertThat(renamed).isEqualTo(slug("moi"));
        assertThat(redirectOf(post.slug())).isEqualTo(renamed);
        assertThat(history(post)).containsExactly(post.slug());
        // The old path is no longer any post: the lookup is what Next asks after that 404.
        assertError(mockMvc.perform(get("/api/v1/posts/" + post.slug())), 404, "POST_NOT_FOUND");
        mockMvc.perform(get("/api/v1/posts/" + renamed)).andExpect(status().isOk());
        // The current slug is nobody's old slug.
        assertNoRedirect(renamed);
    }

    @Test
    void a_b_c_makes_both_a_and_b_point_straight_to_c_in_one_hop() throws Exception {
        Fixture post = publish(create(slug("a")));
        rename(post, slug("b"));
        rename(post, slug("c"));

        assertThat(redirectOf(slug("a"))).isEqualTo(slug("c"));
        assertThat(redirectOf(slug("b"))).isEqualTo(slug("c"));
        assertThat(history(post)).containsExactly(slug("a"), slug("b"));
        assertNoRedirect(slug("c"));
    }

    @Test
    void going_back_to_old_slug_revives_it_its_row_is_gone_and_other_slugs_point_to_it() throws Exception {
        Fixture post = publish(create(slug("a")));
        rename(post, slug("b"));
        rename(post, slug("c"));

        // The post takes back its own old slug: no suffix.
        assertThat(rename(post, slug("a"))).isEqualTo(slug("a"));

        mockMvc.perform(get("/api/v1/posts/" + slug("a"))).andExpect(status().isOk());
        // No loop: a is no longer an old slug, so there is no a → c → a.
        assertNoRedirect(slug("a"));
        assertThat(history(post)).containsExactly(slug("b"), slug("c"));
        assertThat(redirectOf(slug("b"))).isEqualTo(slug("a"));
        assertThat(redirectOf(slug("c"))).isEqualTo(slug("a"));
    }

    // --- An old slug nobody can take ---------------------------------------------------------------

    @Test
    void other_post_asking_old_slug_on_create_gets_suffix_and_old_slug_still_points_to_old_post() throws Exception {
        Fixture post = publish(create(slug("a")));
        rename(post, slug("b"));
        rename(post, slug("c"));

        Fixture other = create(slug("b"));

        assertThat(other.slug()).isEqualTo(slug("b") + "-2");
        assertThat(redirectOf(slug("b"))).isEqualTo(slug("c"));
        // Even when the slug is derived from the title, not from the slug field.
        Fixture fromTitle = create(null, slug("a"));
        assertThat(fromTitle.slug()).isEqualTo(slug("a") + "-2");
        assertThat(redirectOf(slug("a"))).isEqualTo(slug("c"));
        assertThat(history(post)).containsExactly(slug("a"), slug("b"));
    }

    @Test
    void other_post_asking_old_slug_on_update_gets_suffix_and_old_slug_still_points_to_old_post() throws Exception {
        Fixture post = publish(create(slug("a")));
        rename(post, slug("b"));
        rename(post, slug("c"));
        Fixture other = publish(create(slug("khac")));

        assertThat(rename(other, slug("b"))).isEqualTo(slug("b") + "-2");

        assertThat(redirectOf(slug("b"))).isEqualTo(slug("c"));
        // That other post really changed slug (khac → b-2), so its old slug is recorded, for it.
        assertThat(history(other)).containsExactly(slug("khac"));
        assertThat(redirectOf(slug("khac"))).isEqualTo(slug("b") + "-2");
        assertThat(history(post)).containsExactly(slug("a"), slug("b"));
    }

    @Test
    void asking_taken_slug_where_suffix_lands_on_current_slug_changes_nothing() throws Exception {
        Fixture first = publish(create(slug("trung")));
        Fixture second = publish(create(slug("trung")));
        assertThat(second.slug()).isEqualTo(slug("trung") + "-2");

        // "trung" is the other post's, so the suffix leads to the "trung-2" this post already has: not a slug change.
        assertThat(rename(second, slug("trung"))).isEqualTo(slug("trung") + "-2");

        assertThat(history(second)).isEmpty();
        assertThat(history(first)).isEmpty();
        assertNoRedirect(second.slug());
    }

    // --- Drafts, unpublish, delete -------------------------------------------------------------------

    @Test
    void changing_slug_of_never_published_draft_leaves_nothing_and_holds_no_slug() throws Exception {
        Fixture draft = create(slug("nhap"));

        rename(draft, slug("nhap-moi"));

        assertThat(history(draft)).isEmpty();
        assertNoRedirect(slug("nhap"));
        // That slug was never public: another post can take it intact.
        assertThat(create(slug("nhap")).slug()).isEqualTo(slug("nhap"));
    }

    @Test
    void unpublishing_makes_old_slug_404_republishing_redirects_again_including_slug_changed_while_unpublished()
            throws Exception {
        Fixture post = publish(create(slug("a")));
        rename(post, slug("b"));
        assertThat(redirectOf(slug("a"))).isEqualTo(slug("b"));

        unpublish(post);
        // The post is no longer public: no leak of a draft's current slug.
        assertNoRedirect(slug("a"));
        // Changing the slug while unpublished is still recorded: the post was once public under b.
        rename(post, slug("c"));
        assertThat(history(post)).containsExactly(slug("a"), slug("b"));
        assertNoRedirect(slug("a"));
        assertNoRedirect(slug("b"));

        publish(post);
        assertThat(redirectOf(slug("a"))).isEqualTo(slug("c"));
        assertThat(redirectOf(slug("b"))).isEqualTo(slug("c"));

        // ARCHIVED (only reachable through SQL) is not public either.
        assertThat(jdbcTemplate.update("UPDATE posts SET status = 'ARCHIVED' WHERE id = ?", post.id()))
                .isEqualTo(1);
        assertNoRedirect(slug("a"));
    }

    @Test
    void deleting_post_deletes_slug_history_and_old_slug_becomes_404() throws Exception {
        Fixture post = publish(create(slug("a")));
        rename(post, slug("b"));
        assertThat(history(post)).containsExactly(slug("a"));

        mockMvc.perform(delete("/api/v1/admin/posts/" + post.id()).header("Authorization", admin))
                .andExpect(status().isNoContent());

        // ON DELETE CASCADE.
        assertThat(history(post)).isEmpty();
        assertNoRedirect(slug("a"));
        assertNoRedirect(slug("b"));
        // No post holds it any more: the old slug can be reused.
        assertThat(create(slug("a")).slug()).isEqualTo(slug("a"));
    }

    // --- The lookup's answer -------------------------------------------------------------------------

    @Test
    void unknown_slug_or_slug_of_post_never_renamed_is_404_POST_NOT_FOUND() throws Exception {
        assertNoRedirect("khong-co-bai-nay-" + suffix);
        Fixture post = publish(create(slug("chua-doi")));
        assertNoRedirect(post.slug());
    }

    @Test
    void never_returns_the_slug_that_was_asked_even_when_the_data_says_so() throws Exception {
        Fixture post = publish(create(slug("tu-tro")));
        // A row the application never writes (when a post takes back a slug, that slug's row is deleted), as if from a
        // hand
        // edit or an older version: the old slug equals the post's own current slug.
        jdbcTemplate.update("INSERT INTO post_slug_history (old_slug, post_id) VALUES (?, ?)", post.slug(), post.id());

        // Returning that slug would make Next redirect to the page already open, forever.
        assertNoRedirect(post.slug());
    }

    // --- Support ------------------------------------------------------------------------------------

    /** A slug of this test's own. */
    private String slug(String stem) {
        return "lich-su-" + stem + "-" + suffix;
    }

    /** The slug the lookup returns for {@code slug}; fails unless it is a 200 of exactly the shape {@code {"data": {"slug"}}}. */
    private String redirectOf(String slug) throws Exception {
        ResultActions result = mockMvc.perform(get("/api/v1/posts/" + slug + "/redirect"));
        String content = result.andReturn().getResponse().getContentAsString();
        assertThat(result.andReturn().getResponse().getStatus())
                .as("%s: %s", slug, content)
                .isEqualTo(200);
        JsonNode body = objectMapper.readTree(content);
        assertThat(body.propertyNames()).containsExactly("data");
        assertThat(body.path("data").propertyNames()).containsExactly("slug");
        String target = body.path("data").path("slug").asString();
        assertThat(target)
                .as("lookup returned the very slug that was asked for")
                .isNotEqualTo(slug);
        return target;
    }

    private void assertNoRedirect(String slug) throws Exception {
        assertError(mockMvc.perform(get("/api/v1/posts/" + slug + "/redirect")), 404, "POST_NOT_FOUND");
    }

    private void assertError(ResultActions result, int status, String code) throws Exception {
        String content = result.andReturn().getResponse().getContentAsString();
        assertThat(result.andReturn().getResponse().getStatus()).as(content).isEqualTo(status);
        assertThat(objectMapper.readTree(content).path("error").path("code").asString())
                .as(content)
                .isEqualTo(code);
    }

    /** The old slugs recorded for the post, in text order. */
    private List<String> history(Fixture post) {
        return jdbcTemplate.queryForList(
                "SELECT old_slug FROM post_slug_history WHERE post_id = ? ORDER BY old_slug", String.class, post.id());
    }

    private Fixture create(String slug) throws Exception {
        return create(slug, "Slug history post " + slug);
    }

    /** @param slug null leaves the slug field empty: the slug is derived from the title */
    private Fixture create(String slug, String title) throws Exception {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", title);
        body.put("excerpt", "Summary " + suffix);
        body.put("content", "Slug change post content " + suffix);
        body.put("categoryId", categoryId.toString());
        if (slug != null) {
            body.put("slug", slug);
        }
        JsonNode created = data(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isCreated()));
        return new Fixture(
                UUID.fromString(created.path("id").asString()),
                created.path("slug").asString());
    }

    /** A full PUT as the editor sends it, differing only in the slug field; returns the slug the post carries after the save. */
    private String rename(Fixture post, String slug) throws Exception {
        JsonNode current =
                data(mockMvc.perform(get("/api/v1/admin/posts/" + post.id()).header("Authorization", admin))
                        .andExpect(status().isOk()));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", current.path("title").asString());
        body.put("excerpt", current.path("excerpt").asString());
        body.put("content", current.path("content").asString());
        body.put("categoryId", categoryId.toString());
        body.put("tagIds", List.of());
        body.put("slug", slug);
        return data(mockMvc.perform(put("/api/v1/admin/posts/" + post.id())
                                .header("Authorization", admin)
                                .contentType(APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(body)))
                        .andExpect(status().isOk()))
                .path("slug")
                .asString();
    }

    private Fixture publish(Fixture post) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + post.id() + "/publish").header("Authorization", admin))
                .andExpect(status().isOk());
        return post;
    }

    private void unpublish(Fixture post) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + post.id() + "/unpublish").header("Authorization", admin))
                .andExpect(status().isOk());
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("data");
    }
}
