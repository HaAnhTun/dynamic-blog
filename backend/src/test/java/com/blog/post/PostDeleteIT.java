package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.comment.CommentFixtures;
import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.post.service.PostService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Deleting a post. An ADMIN deletes for good, and everything that hangs on the post goes with it. An AUTHOR deleting their own
 * post only hides it (V49): the post leaves the site, the author's list and their control of it, and every row that belongs to
 * somebody else stays: the readers' comments, post likes, saved posts, the newsletter record, the revisions. The slug stays
 * reserved. An ADMIN still sees the hidden post (as ARCHIVED), can delete it for good, or publish it again.
 *
 * Through the real filter chain with real tokens; the DB is shared and never cleaned, every title has a random suffix.
 */
@AutoConfigureMockMvc
class PostDeleteIT extends AbstractIntegrationTest {

    private static final String ADMIN_POSTS = "/api/v1/admin/posts";

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

    /** A published post of a fresh author with a comment, a like and a saved post from a reader. */
    private record Scene(Reader author, Reader reader, Post post) {}

    private Scene scene(String label) throws Exception {
        Reader author = f.author("xoa-bai-" + label);
        Reader reader = f.reader("doc-gia-" + label);
        Post post = f.publishedPostBy(author.bearer(), "Post that is deleted");
        f.create(reader, post, "A comment that belongs to a reader").andExpect(status().isCreated());
        f.likePost(reader, post, true).andExpect(status().isOk());
        mockMvc.perform(put("/api/v1/me/bookmarks/" + post.slug()).header("Authorization", reader.bearer()))
                .andExpect(status().is2xxSuccessful());
        return new Scene(author, reader, post);
    }

    private long count(String table, UUID postId) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM " + table + " WHERE post_id = ?", Long.class, postId);
    }

    private ResultActions deleteAs(String bearer, UUID postId) throws Exception {
        return mockMvc.perform(delete(ADMIN_POSTS + "/" + postId).header("Authorization", bearer));
    }

    @Test
    void an_authors_delete_hides_the_post_and_keeps_every_row_that_belongs_to_somebody_else() throws Exception {
        Scene scene = scene("only");
        UUID id = scene.post().id();
        assertThat(count("comments", id)).isEqualTo(1);
        assertThat(count("post_likes", id)).isEqualTo(1);
        assertThat(count("post_bookmarks", id)).isEqualTo(1);
        assertThat(count("newsletter_issues", id)).isEqualTo(1);

        deleteAs(scene.author().bearer(), id).andExpect(status().isNoContent());

        // Nothing of other people is gone.
        assertThat(count("comments", id)).isEqualTo(1);
        assertThat(count("post_likes", id)).isEqualTo(1);
        assertThat(count("post_bookmarks", id)).isEqualTo(1);
        assertThat(count("newsletter_issues", id)).isEqualTo(1);
        assertThat(jdbcTemplate.queryForMap("SELECT status, deleted_by FROM posts WHERE id = ?", id))
                .containsEntry("status", "ARCHIVED")
                .containsEntry("deleted_by", scene.author().id());
        assertThat(jdbcTemplate.queryForObject("SELECT deleted_at FROM posts WHERE id = ?", Object.class, id))
                .isNotNull();

        // Hidden from the public...
        mockMvc.perform(get("/api/v1/posts/" + scene.post().slug())).andExpect(status().isNotFound());
        mockMvc.perform(get("/api/v1/posts/" + scene.post().slug() + "/comments"))
                .andExpect(status().isNotFound());
        assertThat(slugsOf(get("/api/v1/posts").param("size", "100"), null))
                .doesNotContain(scene.post().slug());
        // ...from the author's list and the author's control...
        assertThat(idsOf(get(ADMIN_POSTS).param("size", "100"), scene.author().bearer()))
                .doesNotContain(id.toString());
        String author = scene.author().bearer();
        mockMvc.perform(get(ADMIN_POSTS + "/" + id).header("Authorization", author))
                .andExpect(status().isForbidden());
        mockMvc.perform(post(ADMIN_POSTS + "/" + id + "/publish").header("Authorization", author))
                .andExpect(status().isForbidden());
        mockMvc.perform(put(ADMIN_POSTS + "/" + id)
                        .header("Authorization", author)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("title", "Back again", "content", "Body"))))
                .andExpect(status().isForbidden());
        deleteAs(author, id).andExpect(status().isForbidden());
        // ...but not from an ADMIN, who sees it as ARCHIVED.
        String admin = auth.bearerForAdmin();
        assertThat(idsOf(get(ADMIN_POSTS).param("size", "100"), admin)).contains(id.toString());
        mockMvc.perform(get(ADMIN_POSTS + "/" + id).header("Authorization", admin))
                .andExpect(status().isOk());
    }

    @Test
    void the_slug_of_a_hidden_post_stays_reserved() throws Exception {
        Scene scene = scene("only");
        deleteAs(scene.author().bearer(), scene.post().id()).andExpect(status().isNoContent());

        String again = objectMapper
                .readTree(mockMvc.perform(post(ADMIN_POSTS)
                                .header("Authorization", auth.bearerForAdmin())
                                .contentType(APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(Map.of(
                                        "slug", scene.post().slug(), "title", "Same address", "content", "Body"))))
                        .andExpect(status().isCreated())
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .path("data")
                .path("slug")
                .asString();

        assertThat(again)
                .isNotEqualTo(scene.post().slug())
                .startsWith(scene.post().slug() + "-");
    }

    @Test
    void an_admin_deletes_for_good_and_everything_goes_with_the_post() throws Exception {
        Scene scene = scene("only");
        UUID id = scene.post().id();

        deleteAs(auth.bearerForAdmin(), id).andExpect(status().isNoContent());

        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM posts WHERE id = ?", Long.class, id))
                .isZero();
        assertThat(count("comments", id)).isZero();
        assertThat(count("post_likes", id)).isZero();
        assertThat(count("post_bookmarks", id)).isZero();
        assertThat(count("newsletter_issues", id)).isZero();
    }

    @Test
    void an_admin_can_delete_a_hidden_post_for_good_or_publish_it_again() throws Exception {
        Scene scene = scene("only");
        UUID id = scene.post().id();
        String admin = auth.bearerForAdmin();
        deleteAs(scene.author().bearer(), id).andExpect(status().isNoContent());

        mockMvc.perform(post(ADMIN_POSTS + "/" + id + "/publish").header("Authorization", admin))
                .andExpect(status().isOk());
        assertThat(jdbcTemplate.queryForMap("SELECT status, deleted_at, deleted_by FROM posts WHERE id = ?", id))
                .containsEntry("status", "PUBLISHED")
                .containsEntry("deleted_at", null)
                .containsEntry("deleted_by", null);
        mockMvc.perform(get("/api/v1/posts/" + scene.post().slug())).andExpect(status().isOk());
        mockMvc.perform(get(ADMIN_POSTS + "/" + id)
                        .header("Authorization", scene.author().bearer()))
                .andExpect(status().isOk());

        deleteAs(scene.author().bearer(), id).andExpect(status().isNoContent());
        deleteAs(admin, id).andExpect(status().isNoContent());
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM posts WHERE id = ?", Long.class, id))
                .isZero();
    }

    @Test
    void another_authors_post_cannot_be_deleted_and_a_second_delete_is_refused_like_any_post_that_is_not_yours()
            throws Exception {
        Scene scene = scene("only");
        Reader other = f.author("khac");

        deleteAs(other.bearer(), scene.post().id()).andExpect(status().isForbidden());
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT status FROM posts WHERE id = ?",
                        String.class,
                        scene.post().id()))
                .isEqualTo("PUBLISHED");
    }

    @Test
    void every_deletion_is_logged_with_ids_and_counts_and_no_text() throws Exception {
        Logger logger = (Logger) LoggerFactory.getLogger(PostService.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            Scene hidden = scene("hidden");
            deleteAs(hidden.author().bearer(), hidden.post().id()).andExpect(status().isNoContent());
            Scene gone = scene("gone");
            deleteAs(auth.bearerForAdmin(), gone.post().id()).andExpect(status().isNoContent());

            List<String> lines = appender.list.stream()
                    .map(ILoggingEvent::getFormattedMessage)
                    .toList();
            assertThat(lines)
                    .anySatisfy(line -> assertThat(line)
                            .contains("post deleted postId=" + hidden.post().id())
                            .contains("by=" + hidden.author().id())
                            .contains("role=AUTHOR kind=hidden comments=1"))
                    .anySatisfy(line -> assertThat(line)
                            .contains("post deleted postId=" + gone.post().id())
                            .contains("role=ADMIN kind=hard comments=1"));
            assertThat(String.join("\n", lines))
                    .doesNotContain("Post that is deleted")
                    .doesNotContain("A comment that");
        } finally {
            logger.detachAppender(appender);
        }
    }

    private List<String> idsOf(
            org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder request, String bearer)
            throws Exception {
        return fieldsOf(request, bearer, "id");
    }

    private List<String> slugsOf(
            org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder request, String bearer)
            throws Exception {
        return fieldsOf(request, bearer, "slug");
    }

    private List<String> fieldsOf(
            org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder request,
            String bearer,
            String field)
            throws Exception {
        if (bearer != null) {
            request.header("Authorization", bearer);
        }
        JsonNode page = objectMapper
                .readTree(mockMvc.perform(request)
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .path("data");
        List<String> values = new ArrayList<>();
        for (JsonNode item : page) {
            values.add(item.path(field).asString());
        }
        return values;
    }
}
