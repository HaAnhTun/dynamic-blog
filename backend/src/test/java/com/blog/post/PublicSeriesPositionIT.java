package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.comment.CommentFixtures;
import com.blog.comment.CommentFixtures.Post;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The series reference in a public post answer. The stored position of a part can have gaps (a part that is still a draft), so a
 * public answer carries the number among the PUBLISHED parts in {@code position} too: a gap would tell any reader how many
 * unpublished posts the series has. The admin API keeps the stored position for a post that is not published.
 *
 * The DB is shared and never cleaned: the series and the posts have a random suffix.
 */
@AutoConfigureMockMvc
class PublicSeriesPositionIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    private JsonNode data(String url, String bearer) throws Exception {
        var request = get(url);
        if (bearer != null) {
            request.header("Authorization", bearer);
        }
        return objectMapper
                .readTree(mockMvc.perform(request)
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .path("data");
    }

    @Test
    void a_gap_in_the_stored_positions_is_not_visible_in_a_public_answer() throws Exception {
        CommentFixtures f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
        Post hidden = f.draftPost("Series part still a draft");
        Post shown = f.publishedPost("Series part that is public");
        UUID series = UUID.randomUUID();
        jdbcTemplate.update(
                "insert into series (id, title, slug) values (?, ?, ?)",
                series,
                "Gap series " + f.suffix,
                "gap-" + f.suffix);
        // The draft is part 1 and the published post is stored as part 2 (and a third, removed part left position 3
        // free).
        jdbcTemplate.update("update posts set series_id = ?, series_position = 1 where id = ?", series, hidden.id());
        jdbcTemplate.update("update posts set series_id = ?, series_position = 2 where id = ?", series, shown.id());

        JsonNode published = data("/api/v1/posts/" + shown.slug(), null).path("series");

        assertThat(published.path("partNumber").asInt()).isEqualTo(1);
        assertThat(published.path("partCount").asInt()).isEqualTo(1);
        assertThat(published.path("position").asInt()).isEqualTo(1);
        // The list carries the same.
        boolean found = false;
        for (JsonNode item : data("/api/v1/posts?size=100", null)) {
            if (shown.slug().equals(item.path("slug").asString())) {
                assertThat(item.path("series").path("position").asInt()).isEqualTo(1);
                found = true;
            }
        }
        assertThat(found).isTrue();
        // Nothing in the public answer carries the number 2.
        assertThat(published.toString()).doesNotContain("\"position\":2");

        // The author or an administrator reading the DRAFT still gets its stored position, for ordering.
        JsonNode draft = data("/api/v1/admin/posts/" + hidden.id(), auth.bearerForAdmin())
                .path("series");
        assertThat(draft.path("position").asInt()).isEqualTo(1);
        assertThat(draft.path("partNumber").isNull()).isTrue();
    }
}
