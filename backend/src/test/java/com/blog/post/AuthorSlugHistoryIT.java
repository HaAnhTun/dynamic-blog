package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.comment.CommentFixtures;
import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The old addresses of a post. An AUTHOR's post keeps only its newest five (so renaming again and again cannot reserve a lot of
 * the site's address space for good), an ADMIN's post keeps them all, and an ADMIN can release one old address with
 * {@code DELETE /api/v1/admin/slug-history/{slug}} so that another post can take it. The DB is shared and never cleaned: every
 * slug has a random suffix.
 */
@AutoConfigureMockMvc
class AuthorSlugHistoryIT extends AbstractIntegrationTest {

    private static final String ADMIN_POSTS = "/api/v1/admin/posts";
    private static final int KEPT = 5;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    private CommentFixtures f;

    @BeforeEach
    void setUp() {
        f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
    }

    /** Renames a post with a full PUT, keeping its title, content and category; returns the slug the answer carries. */
    private String rename(String bearer, Post post, String slug) throws Exception {
        JsonNode current = objectMapper
                .readTree(mockMvc.perform(get(ADMIN_POSTS + "/" + post.id()).header("Authorization", bearer))
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .path("data");
        String body = objectMapper.writeValueAsString(Map.of(
                "title", current.path("title").asString(),
                "content", current.path("content").asString(),
                "categoryId", current.path("category").path("id").asString(),
                "slug", slug));
        return objectMapper
                .readTree(mockMvc.perform(put(ADMIN_POSTS + "/" + post.id())
                                .header("Authorization", bearer)
                                .contentType(APPLICATION_JSON)
                                .content(body))
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .path("data")
                .path("slug")
                .asString();
    }

    private List<String> historyOf(UUID postId) {
        return jdbcTemplate.queryForList(
                "SELECT old_slug FROM post_slug_history WHERE post_id = ? ORDER BY created_at, old_slug",
                String.class,
                postId);
    }

    /** Renames {@code times} times and returns the slugs the post has had, oldest first, the current one last. */
    private List<String> renameTimes(String bearer, Post post, int times) throws Exception {
        List<String> had = new ArrayList<>(List.of(post.slug()));
        for (int i = 0; i < times; i++) {
            had.add(rename(bearer, post, "renamed-" + i + "-" + f.suffix));
        }
        return had;
    }

    @Test
    void an_authors_post_keeps_only_its_newest_old_addresses() throws Exception {
        Reader author = f.author("doi-dia-chi");
        Post post = f.publishedPostBy(author.bearer(), "Renamed again and again");

        List<String> had = renameTimes(author.bearer(), post, KEPT + 2);

        List<String> kept = historyOf(post.id());
        assertThat(kept).hasSize(KEPT);
        // The newest old addresses are the ones kept: the one just before the current slug, and four before it.
        assertThat(kept).containsExactlyInAnyOrderElementsOf(had.subList(had.size() - 1 - KEPT, had.size() - 1));
        // Those still redirect to the post; the oldest two no longer do.
        for (String slug : kept) {
            mockMvc.perform(get("/api/v1/posts/" + slug + "/redirect")).andExpect(status().isOk());
        }
        mockMvc.perform(get("/api/v1/posts/" + had.get(0) + "/redirect")).andExpect(status().isNotFound());
        mockMvc.perform(get("/api/v1/posts/" + had.get(1) + "/redirect")).andExpect(status().isNotFound());
    }

    @Test
    void an_admins_post_keeps_every_old_address() throws Exception {
        Post post = f.publishedPost("Renamed by the administrator");

        renameTimes(auth.bearerForAdmin(), post, KEPT + 3);

        assertThat(historyOf(post.id())).hasSize(KEPT + 3);
    }

    @Test
    void an_admin_releases_one_old_address_and_another_post_can_take_it() throws Exception {
        Reader author = f.author("tra-dia-chi");
        Post post = f.publishedPostBy(author.bearer(), "Gives an address up");
        List<String> had = renameTimes(author.bearer(), post, 2);
        String released = had.get(0);
        String stays = had.get(1);
        assertThat(historyOf(post.id())).containsExactlyInAnyOrder(released, stays);

        // An AUTHOR cannot release anything; an unknown address is a 404 with its own code.
        mockMvc.perform(delete("/api/v1/admin/slug-history/" + released).header("Authorization", author.bearer()))
                .andExpect(status().isForbidden());
        String admin = auth.bearerForAdmin();
        mockMvc.perform(delete("/api/v1/admin/slug-history/never-" + f.suffix).header("Authorization", admin))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("SLUG_HISTORY_NOT_FOUND"));
        // Before the release another post cannot take the address: it gets a numbered one.
        assertThat(slugOfNewPost(admin, released)).isEqualTo(released + "-2");

        mockMvc.perform(delete("/api/v1/admin/slug-history/" + released).header("Authorization", admin))
                .andExpect(status().isNoContent());

        assertThat(historyOf(post.id())).containsExactly(stays);
        mockMvc.perform(get("/api/v1/posts/" + released + "/redirect")).andExpect(status().isNotFound());
        mockMvc.perform(get("/api/v1/posts/" + stays + "/redirect")).andExpect(status().isOk());
        assertThat(slugOfNewPost(admin, released)).isEqualTo(released);
    }

    private String slugOfNewPost(String bearer, String wanted) throws Exception {
        return objectMapper
                .readTree(mockMvc.perform(post(ADMIN_POSTS)
                                .header("Authorization", bearer)
                                .contentType(APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(
                                        Map.of("slug", wanted, "title", "Wants " + wanted, "content", "Body"))))
                        .andExpect(status().isCreated())
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .path("data")
                .path("slug")
                .asString();
    }
}
