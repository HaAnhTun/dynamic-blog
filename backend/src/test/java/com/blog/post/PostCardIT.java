package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.common.security.SeedAdmin;
import com.blog.common.text.ReadingTime;
import com.blog.post.entity.PostCard;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Issue 013: no list of posts reads the body. Every list statement selects the columns of {@link PostCard}, the row of
 * {@code posts} without its text, and the reading time on a card is the figure stored with the post. The SQL is captured from
 * the {@code org.hibernate.SQL} logger, so what is checked is what really goes to the database.
 */
@AutoConfigureMockMvc
class PostCardIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AuthTestSupport auth;

    private UUID publishedPost(String slug, String content, int readingMinutes) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO posts (id, title, slug, excerpt, content, status, language, author_id, published_at, reading_minutes) "
                        + "VALUES (?, ?, ?, 'An excerpt', ?, 'PUBLISHED', 'en', ?, now(), ?)",
                id,
                "Card " + slug,
                slug,
                content,
                SeedAdmin.ID,
                readingMinutes);
        return id;
    }

    @Test
    void the_card_maps_every_column_of_posts_except_the_body_and_the_search_vector() {
        Set<String> table = jdbcTemplate
                .queryForList(
                        "SELECT column_name FROM information_schema.columns WHERE table_name = 'posts'", String.class)
                .stream()
                .collect(Collectors.toSet());

        assertThat(table).contains("content", "search_vector");
        table.remove("content");
        table.remove("search_vector");
        // A column added to posts later must be added to PostCard.COLUMNS (and PostHead), or a list would not show it.
        assertThat(PostCard.columnNames()).containsExactlyInAnyOrderElementsOf(table);
    }

    @Test
    void no_list_statement_selects_the_body_and_the_detail_does() throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 8).toLowerCase(Locale.ROOT);
        String slug = "card-it-" + suffix;
        String body = ("zebra" + suffix + " ").repeat(450);
        publishedPost(slug, body, ReadingTime.minutes(body));
        String admin = auth.bearerForAdmin();
        User reader = auth.createReader(auth.nextGithubId(), "card-reader-" + suffix);
        String readerToken = auth.bearerFor(reader);
        mockMvc.perform(put("/api/v1/me/bookmarks/" + slug).header("Authorization", readerToken))
                .andExpect(status().isOk());

        Logger sql = (Logger) LoggerFactory.getLogger("org.hibernate.SQL");
        Level previous = sql.getLevel();
        ListAppender<ILoggingEvent> events = new ListAppender<>();
        events.start();
        sql.setLevel(Level.DEBUG);
        sql.addAppender(events);
        try {
            for (String path : List.of(
                    "/api/v1/posts?size=50",
                    "/api/v1/posts?size=50&lang=en",
                    "/api/v1/posts?sort=popular&size=50",
                    "/api/v1/posts?sort=popular&size=50&lang=en",
                    "/api/v1/posts?featured=true",
                    "/api/v1/posts/search?q=zebra" + suffix,
                    "/api/v1/series")) {
                mockMvc.perform(get(path)).andExpect(status().isOk());
            }
            mockMvc.perform(get("/api/v1/admin/posts?size=50").header("Authorization", admin))
                    .andExpect(status().isOk());
            mockMvc.perform(get("/api/v1/me/bookmarks").header("Authorization", readerToken))
                    .andExpect(status().isOk());
            List<String> listStatements = statementsOnPosts(events);
            assertThat(listStatements).isNotEmpty();
            assertThat(listStatements).noneMatch(PostCardIT::selectsTheBody);

            // The control: the detail of one post reads its body, and the same detector sees it.
            events.list.clear();
            mockMvc.perform(get("/api/v1/posts/" + slug)).andExpect(status().isOk());
            assertThat(statementsOnPosts(events)).anyMatch(PostCardIT::selectsTheBody);
        } finally {
            sql.detachAppender(events);
            sql.setLevel(previous);
            events.stop();
        }
    }

    @Test
    void a_card_shows_the_reading_time_stored_with_the_post_and_the_detail_agrees() throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 8).toLowerCase(Locale.ROOT);
        String slug = "card-minutes-" + suffix;
        String body = "word ".repeat(1_000);
        publishedPost(slug, body, ReadingTime.minutes(body));

        JsonNode card = findBySlug(get("/api/v1/posts?size=50&lang=en"), slug);
        JsonNode detail = objectMapper
                .readTree(mockMvc.perform(get("/api/v1/posts/" + slug))
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .path("data");

        assertThat(card.path("readingMinutes").asInt()).isEqualTo(5);
        assertThat(detail.path("readingMinutes").asInt()).isEqualTo(5);
    }

    @Test
    void a_row_that_was_never_given_a_figure_shows_one_minute_until_the_backfill_reaches_it() throws Exception {
        String suffix = UUID.randomUUID().toString().substring(0, 8).toLowerCase(Locale.ROOT);
        String slug = "card-zero-" + suffix;
        publishedPost(slug, "word ".repeat(1_000), 0);

        JsonNode card = findBySlug(get("/api/v1/posts?size=50&lang=en"), slug);

        assertThat(card.path("readingMinutes").asInt()).isEqualTo(1);
    }

    private JsonNode findBySlug(
            org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder request, String slug)
            throws Exception {
        JsonNode items = objectMapper
                .readTree(mockMvc.perform(request).andReturn().getResponse().getContentAsString())
                .path("data");
        for (JsonNode item : items) {
            if (slug.equals(item.path("slug").asString())) {
                return item;
            }
        }
        throw new AssertionError("no card with slug " + slug + " in the first page");
    }

    /** The SQL statements that read the posts table, without those of other tables that also have a content column. */
    private static List<String> statementsOnPosts(ListAppender<ILoggingEvent> events) {
        return events.list.stream()
                .map(ILoggingEvent::getFormattedMessage)
                .map(statement -> statement.toLowerCase(Locale.ROOT))
                .filter(statement -> statement.startsWith("select ") && statement.contains(" from posts "))
                .toList();
    }

    /** Whether the select list of a statement (up to the first FROM) names the content column. */
    private static boolean selectsTheBody(String statement) {
        int from = statement.indexOf(" from ");
        String selected = statement.substring(0, from);
        return selected.contains(".content") || selected.contains(" content");
    }
}
