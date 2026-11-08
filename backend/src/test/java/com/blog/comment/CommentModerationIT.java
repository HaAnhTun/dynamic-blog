package com.blog.comment;

import static com.blog.comment.CommentFixtures.replyIds;
import static com.blog.comment.CommentFixtures.rootIds;
import static com.blog.comment.CommentFixtures.thread;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import jakarta.persistence.EntityManagerFactory;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Admin comment moderation: {@code GET /api/v1/admin/comments},
 * {@code PATCH /api/v1/admin/comments/{id}/status}, {@code DELETE /api/v1/admin/comments/{id}}.
 *
 * The DB is shared by the whole suite and never cleaned, so the list is always read with {@code q} set to the
 * own suffix of the test: the content, or the login and name of the writer, of every comment the test creates
 * contains it. The races between moderation and the author are in CommentConcurrencyIT.
 */
@AutoConfigureMockMvc
class CommentModerationIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private EntityManagerFactory entityManagerFactory;

    private CommentFixtures f;

    @BeforeEach
    void setUp() {
        f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
    }

    // --- List ------------------------------------------------------------------------------------------

    @Test
    void list_newest_first_with_post_and_writer_and_also_hidden_and_deleted_content() throws Exception {
        Post post = f.publishedPost("Moderation list");
        Post draft = f.draftPost("Draft with comments");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        Instant base = Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MICROS);
        UUID root = f.insertComment(post, an.id(), null, "Root " + f.suffix, "VISIBLE", base);
        UUID reply = f.insertComment(post, binh.id(), root, "Reply " + f.suffix, "VISIBLE", base.plusSeconds(1));
        UUID hidden = f.insertComment(post, an.id(), null, "Hidden " + f.suffix, "HIDDEN", base.plusSeconds(2));
        UUID deleted = f.insertComment(post, binh.id(), null, "Deleted " + f.suffix, "DELETED", base.plusSeconds(3));
        // A post that is not published takes no comments through the API, but comments made before the post
        // was unpublished remain.
        UUID onDraft = f.insertComment(draft, an.id(), null, "On a draft " + f.suffix, "VISIBLE", base.plusSeconds(4));
        Instant editedAt = base.plusSeconds(30);
        jdbcTemplate.update(
                "UPDATE comments SET edited_at = ? WHERE id = ?",
                OffsetDateTime.ofInstant(editedAt, ZoneOffset.UTC),
                root);

        JsonNode body = f.body(f.adminList("q", f.suffix).andExpect(status().isOk()));

        assertThat(ids(body)).containsExactly(onDraft, deleted, hidden, reply, root);
        assertPagination(body, 0, 20, 5, 1);

        JsonNode first = item(body, root);
        assertThat(first.propertyNames())
                .containsExactlyInAnyOrder(
                        "id",
                        "content",
                        "status",
                        "reply",
                        "createdAt",
                        "editedAt",
                        "postId",
                        "postSlug",
                        "postTitle",
                        "postStatus",
                        "authorId",
                        "authorDisplayName",
                        "authorGithubLogin",
                        "authorAvatarUrl",
                        "authorRole",
                        "authorStatus");
        assertThat(first.path("content").asString()).isEqualTo("Root " + f.suffix);
        assertThat(first.path("status").asString()).isEqualTo("VISIBLE");
        assertThat(first.path("reply").asBoolean()).isFalse();
        assertThat(Instant.parse(first.path("createdAt").asString())).isEqualTo(base);
        assertThat(Instant.parse(first.path("editedAt").asString())).isEqualTo(editedAt);
        assertThat(first.path("postId").asString()).isEqualTo(post.id().toString());
        assertThat(first.path("postSlug").asString()).isEqualTo(post.slug());
        assertThat(first.path("postTitle").asString()).isEqualTo("Moderation list " + f.suffix);
        assertThat(first.path("postStatus").asString()).isEqualTo("PUBLISHED");
        assertThat(first.path("authorId").asString()).isEqualTo(an.id().toString());
        assertThat(first.path("authorDisplayName").asString()).isEqualTo(an.displayName());
        assertThat(first.path("authorGithubLogin").asString()).isEqualTo(an.login());
        assertThat(first.path("authorAvatarUrl").asString()).startsWith("https://avatars.githubusercontent.com/u/");
        assertThat(first.path("authorRole").asString()).isEqualTo("USER");
        assertThat(first.path("authorStatus").asString()).isEqualTo("ACTIVE");

        assertThat(item(body, reply).path("reply").asBoolean()).isTrue();
        assertThat(item(body, reply).path("editedAt").isNull()).isTrue();
        assertThat(item(body, reply).path("authorId").asString())
                .isEqualTo(binh.id().toString());
        // Moderation history: hidden and deleted content can still be read, and only here.
        assertThat(item(body, hidden).path("status").asString()).isEqualTo("HIDDEN");
        assertThat(item(body, hidden).path("content").asString()).isEqualTo("Hidden " + f.suffix);
        assertThat(item(body, deleted).path("status").asString()).isEqualTo("DELETED");
        assertThat(item(body, deleted).path("content").asString()).isEqualTo("Deleted " + f.suffix);
        assertThat(item(body, onDraft).path("postStatus").asString()).isEqualTo("DRAFT");
        assertThat(item(body, onDraft).path("postId").asString())
                .isEqualTo(draft.id().toString());
    }

    @Test
    void filter_by_status_and_search_by_content_login_or_name_case_insensitive() throws Exception {
        Post post = f.publishedPost("Filter and search comments");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        Instant base = Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MICROS);
        UUID visible = f.insertComment(post, an.id(), null, "Spring Boot is easy " + f.suffix, "VISIBLE", base);
        UUID hidden = f.insertComment(post, binh.id(), null, "Advert " + f.suffix, "HIDDEN", base.plusSeconds(1));
        UUID deleted =
                f.insertComment(post, an.id(), null, "Slip of the hand " + f.suffix, "DELETED", base.plusSeconds(2));

        assertThat(listIds("q", f.suffix, "status", "VISIBLE")).containsExactly(visible);
        assertThat(listIds("q", f.suffix, "status", "HIDDEN")).containsExactly(hidden);
        assertThat(listIds("q", f.suffix, "status", "DELETED")).containsExactly(deleted);
        // An empty status means no filter, like "All" in the UI.
        assertThat(listIds("q", f.suffix, "status", "")).containsExactly(deleted, hidden, visible);

        // Content, case insensitive.
        assertThat(listIds("q", "SPRING BOOT IS EASY " + f.suffix.toUpperCase(Locale.ROOT)))
                .containsExactly(visible);
        // The writer login, typed in uppercase.
        assertThat(listIds("q", binh.login().toUpperCase(Locale.ROOT))).containsExactly(hidden);
        // Display name: the whole name of An is in no content and in no login.
        assertThat(listIds("q", an.displayName())).containsExactly(deleted, visible);
        // Filter and search together.
        assertThat(listIds("q", an.login(), "status", "DELETED")).containsExactly(deleted);

        // A search string of only whitespace means no search: the same result as not sending q.
        long everything = f.body(f.adminList().andExpect(status().isOk()))
                .path("pagination")
                .path("totalElements")
                .asLong();
        assertThat(f.body(f.adminList("q", "   ").andExpect(status().isOk()))
                        .path("pagination")
                        .path("totalElements")
                        .asLong())
                .isEqualTo(everything)
                .isGreaterThanOrEqualTo(3);

        f.assertError(f.adminList("status", "BOGUS"), 400, "VALIDATION_ERROR");
        f.assertError(f.adminList("status", "hidden"), 400, "VALIDATION_ERROR");
    }

    @Test
    void filter_by_post_applies_to_page_and_total_with_status_and_search_and_malformed_id_is_400() throws Exception {
        Post post = f.publishedPost("Filter by post");
        Post other = f.publishedPost("Other post with the same suffix");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        Instant base = Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MICROS);
        UUID visible = f.insertComment(post, an.id(), null, "Root " + f.suffix, "VISIBLE", base);
        UUID reply = f.insertComment(post, binh.id(), visible, "Reply " + f.suffix, "VISIBLE", base.plusSeconds(1));
        UUID hidden = f.insertComment(post, binh.id(), null, "Hidden " + f.suffix, "HIDDEN", base.plusSeconds(2));
        UUID deleted = f.insertComment(post, an.id(), null, "Deleted " + f.suffix, "DELETED", base.plusSeconds(3));
        UUID elsewhere =
                f.insertComment(other, an.id(), null, "On another post " + f.suffix, "VISIBLE", base.plusSeconds(4));
        String postId = post.id().toString();

        // Only the comments of that post, every status, newest first; comments with the same suffix on
        // another post do not get in.
        JsonNode all = f.body(f.adminList("postId", postId).andExpect(status().isOk()));
        assertThat(ids(all)).containsExactly(deleted, hidden, reply, visible).doesNotContain(elsewhere);
        assertPagination(all, 0, 20, 4, 1);
        // The count query filters with the same condition: page of 1 item, the total is still 4, not every
        // comment of the site.
        JsonNode firstPage = f.body(f.adminList("postId", postId, "size", "1").andExpect(status().isOk()));
        assertThat(ids(firstPage)).containsExactly(deleted);
        assertPagination(firstPage, 0, 1, 4, 4);

        // Together with the status and the search string.
        assertThat(listIds("postId", postId, "status", "HIDDEN")).containsExactly(hidden);
        assertThat(listIds("postId", postId, "q", "reply " + f.suffix)).containsExactly(reply);
        assertThat(listIds("postId", postId, "q", binh.login(), "status", "VISIBLE"))
                .containsExactly(reply);
        assertThat(listIds("postId", other.id().toString())).containsExactly(elsewhere);
        // Control: without the filter, comments of both posts are there.
        assertThat(listIds("q", f.suffix)).contains(elsewhere, visible);

        // An id that is no post: an empty page, not a 404 (this is a filter). Empty means no filter.
        JsonNode none =
                f.body(f.adminList("postId", UUID.randomUUID().toString()).andExpect(status().isOk()));
        assertThat(ids(none)).isEmpty();
        assertPagination(none, 0, 20, 0, 0);
        assertThat(listIds("postId", "", "q", f.suffix)).contains(elsewhere, visible);
        f.assertError(f.adminList("postId", "khong-phai-uuid"), 400, "VALIDATION_ERROR");
    }

    @Test
    void percent_underscore_and_backslash_in_search_string_are_literal_characters() throws Exception {
        Post post = f.publishedPost("Wildcard characters");
        Reader an = f.reader("an");
        Instant base = Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MICROS);
        UUID percent = f.insertComment(post, an.id(), null, f.suffix + " 50% off tuition", "VISIBLE", base);
        UUID noPercent =
                f.insertComment(post, an.id(), null, f.suffix + " 50 off tuition", "VISIBLE", base.plusSeconds(1));
        UUID underscore = f.insertComment(post, an.id(), null, f.suffix + " var_name", "VISIBLE", base.plusSeconds(2));
        UUID letter = f.insertComment(post, an.id(), null, f.suffix + " varxname", "VISIBLE", base.plusSeconds(3));
        UUID backslash = f.insertComment(post, an.id(), null, f.suffix + " C:\\temp", "VISIBLE", base.plusSeconds(4));
        UUID plain = f.insertComment(post, an.id(), null, f.suffix + " C:temp", "VISIBLE", base.plusSeconds(5));

        // Without escaping, "%" would match everything, "_" any single character, and "\t" would just be the
        // letter "t".
        assertThat(listIds("q", f.suffix + " 50% off")).containsExactly(percent).doesNotContain(noPercent);
        assertThat(listIds("q", f.suffix + " var_name"))
                .containsExactly(underscore)
                .doesNotContain(letter);
        assertThat(listIds("q", f.suffix + " C:\\temp"))
                .containsExactly(backslash)
                .doesNotContain(plain);
    }

    @Test
    void pagination_newest_first_then_by_id_and_page_size_clamped_1_to_100() throws Exception {
        Post post = f.publishedPost("Moderation page");
        Reader an = f.reader("an");
        Instant base = Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MICROS);
        UUID oldest = f.insertComment(post, an.id(), null, "Oldest " + f.suffix, "VISIBLE", base);
        // Two comments of the same instant: the larger id comes first, for a deterministic order between two
        // pages.
        String stem = UUID.randomUUID().toString().substring(0, 35);
        UUID tieLow = f.insertComment(
                UUID.fromString(stem + "1"),
                post,
                an.id(),
                null,
                "Same instant 1 " + f.suffix,
                "VISIBLE",
                base.plusSeconds(1));
        UUID tieHigh = f.insertComment(
                UUID.fromString(stem + "2"),
                post,
                an.id(),
                null,
                "Same instant 2 " + f.suffix,
                "VISIBLE",
                base.plusSeconds(1));
        List<UUID> newestFirst = List.of(tieHigh, tieLow, oldest);

        JsonNode first = f.body(f.adminList("q", f.suffix, "size", "2").andExpect(status().isOk()));
        assertThat(ids(first)).containsExactlyElementsOf(newestFirst.subList(0, 2));
        assertPagination(first, 0, 2, 3, 2);
        JsonNode second =
                f.body(f.adminList("q", f.suffix, "size", "2", "page", "1").andExpect(status().isOk()));
        assertThat(ids(second)).containsExactly(oldest);
        assertPagination(second, 1, 2, 3, 2);
        JsonNode beyond =
                f.body(f.adminList("q", f.suffix, "size", "2", "page", "9").andExpect(status().isOk()));
        assertThat(ids(beyond)).isEmpty();
        assertPagination(beyond, 9, 2, 3, 2);

        assertPagination(f.body(f.adminList("q", f.suffix, "size", "0")), 0, 1, 3, 3);
        assertPagination(f.body(f.adminList("q", f.suffix, "size", "-4")), 0, 1, 3, 3);
        JsonNode capped = f.body(f.adminList("q", f.suffix, "size", "1000", "page", "-2"));
        assertPagination(capped, 0, 100, 3, 1);
        assertThat(ids(capped)).containsExactlyElementsOf(newestFirst);
        f.assertError(f.adminList("page", "mot"), 400, "VALIDATION_ERROR");
    }

    @Test
    void list_sql_reads_only_selected_columns_never_post_content_or_email() throws Exception {
        Post post = f.publishedPost("Long post not loaded");
        Reader an = f.reader("an");
        Instant base = Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.MICROS);
        f.insertComment(post, an.id(), null, "Comment one " + f.suffix, "VISIBLE", base);
        f.insertComment(post, an.id(), null, "Comment two " + f.suffix, "HIDDEN", base.plusSeconds(1));

        Statistics statistics =
                entityManagerFactory.unwrap(SessionFactory.class).getStatistics();
        boolean wasEnabled = statistics.isStatisticsEnabled();
        statistics.setStatisticsEnabled(true);
        List<String> statements;
        MockHttpServletResponse response;
        try {
            statistics.clear();
            // Page size 1 of 2 results: there is both the page select and the count query.
            List<MockHttpServletResponse> captured = new ArrayList<>();
            statements = sqlDuring(() -> captured.add(f.adminList("q", f.suffix, "size", "1")
                    .andExpect(status().isOk())
                    .andReturn()
                    .getResponse()));
            response = captured.getFirst();
            // A projection: Hibernate builds no entity, not even a Post with the whole article inside.
            assertThat(statistics.getEntityLoadCount()).isZero();
        } finally {
            statistics.setStatisticsEnabled(wasEnabled);
        }

        List<String> withPosts =
                statements.stream().filter(sql -> POSTS.matcher(sql).find()).toList();
        assertThat(withPosts)
                .as("page-select query reads through the posts table: %s", statements)
                .isNotEmpty();
        for (String sql : statements) {
            assertThat(columnsOf(sql, POSTS)).as(sql).isSubsetOf("id", "slug", "title", "status");
            assertThat(columnsOf(sql, USERS))
                    .as(sql)
                    .isSubsetOf(
                            "id", "display_name", "github_login", "avatar_url", "role", "status", "tokens_valid_after");
        }
        assertThat(statements)
                .as("count query")
                .anySatisfy(sql -> assertThat(sql).containsIgnoringCase("count("));

        assertThat(response.getContentAsString())
                .contains("Comment two " + f.suffix)
                .doesNotContain("Post content to discuss " + f.suffix)
                .doesNotContain("Summary " + f.suffix);
    }

    // --- Hide, unhide, delete --------------------------------------------------------------------------

    @Test
    void hide_and_unhide_change_exactly_what_readers_see_and_repeating_is_a_noop() throws Exception {
        Post post = f.publishedPost("Hide and unhide comments");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID root = f.createdId(f.create(an, post, "Root about to be hidden"));
        UUID reply = f.createdId(f.reply(binh, root, "Reply still visible"));
        UUID alone = f.createdId(f.create(binh, post, "Root nobody replied to"));

        JsonNode hiddenRoot = f.data(f.moderate(root, "HIDDEN").andExpect(status().isOk()));
        assertThat(hiddenRoot.path("id").asString()).isEqualTo(root.toString());
        assertThat(hiddenRoot.path("status").asString()).isEqualTo("HIDDEN");
        assertThat(hiddenRoot.path("content").asString()).isEqualTo("Root about to be hidden");
        assertThat(hiddenRoot.path("authorId").asString()).isEqualTo(an.id().toString());
        f.moderate(alone, "HIDDEN").andExpect(status().isOk());

        // A hidden root that still has replies: a placeholder. A hidden root without replies: disappears.
        JsonNode page = f.page(post);
        assertThat(rootIds(page)).containsExactly(root);
        JsonNode placeholder = thread(page, root).path("comment");
        assertThat(placeholder.path("status").asString()).isEqualTo("HIDDEN");
        assertThat(placeholder.path("content").isNull()).isTrue();
        assertThat(placeholder.path("author").isNull()).isTrue();
        assertThat(replyIds(thread(page, root))).containsExactly(reply);

        // Hiding the last reply too: the root has no visible reply left, so it disappears with it.
        f.moderate(reply, "HIDDEN").andExpect(status().isOk());
        assertThat(rootIds(f.page(post))).isEmpty();

        // Hiding an already hidden comment: 200, the row is not touched.
        Object hiddenSince = f.row(alone).get("updated_at");
        assertThat(f.data(f.moderate(alone, "HIDDEN").andExpect(status().isOk()))
                        .path("status")
                        .asString())
                .isEqualTo("HIDDEN");
        assertThat(f.row(alone).get("updated_at")).isEqualTo(hiddenSince);

        for (UUID id : List.of(root, reply, alone)) {
            assertThat(f.data(f.moderate(id, "VISIBLE").andExpect(status().isOk()))
                            .path("status")
                            .asString())
                    .isEqualTo("VISIBLE");
        }
        page = f.page(post);
        assertThat(rootIds(page)).containsExactly(root, alone);
        JsonNode restored = thread(page, root).path("comment");
        assertThat(restored.path("content").asString()).isEqualTo("Root about to be hidden");
        assertThat(restored.path("author").path("displayName").asString()).isEqualTo(an.displayName());
        assertThat(replyIds(thread(page, root))).containsExactly(reply);

        // Unhiding a comment that is visible: 200, the row is not touched.
        Object visibleSince = f.row(alone).get("updated_at");
        f.moderate(alone, "VISIBLE").andExpect(status().isOk());
        assertThat(f.row(alone).get("updated_at")).isEqualTo(visibleSince);

        // Moderation never touches the content or "edited"; the writer can still edit a comment that was
        // shown again.
        assertThat(f.row(root).get("content")).isEqualTo("Root about to be hidden");
        assertThat(f.row(root).get("edited_at")).isNull();
        f.edit(an, root, "Root unhidden again").andExpect(status().isOk());
    }

    @Test
    void admin_delete_is_204_repeating_is_still_204_and_deleted_comment_cannot_be_unhidden_or_hidden()
            throws Exception {
        Post post = f.publishedPost("Admin deletes comments");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID root = f.createdId(f.create(an, post, "Root to be deleted by the admin"));
        UUID reply = f.createdId(f.reply(binh, root, "Reply remains"));
        UUID hidden = f.createdId(f.create(binh, post, "Hidden first, deleted later"));
        f.moderate(hidden, "HIDDEN").andExpect(status().isOk());

        MockHttpServletResponse deleted = f.adminDelete(root)
                .andExpect(status().isNoContent())
                .andReturn()
                .getResponse();
        assertThat(deleted.getContentAsString()).isEmpty();
        f.adminDelete(root).andExpect(status().isNoContent());
        f.adminDelete(hidden).andExpect(status().isNoContent());

        // Soft delete: the content is kept for moderation.
        assertThat(f.row(root).get("status")).isEqualTo("DELETED");
        assertThat(f.row(root).get("content")).isEqualTo("Root to be deleted by the admin");
        assertThat(f.row(hidden).get("status")).isEqualTo("DELETED");

        JsonNode page = f.page(post);
        assertThat(rootIds(page)).containsExactly(root);
        assertThat(thread(page, root).path("comment").path("status").asString()).isEqualTo("DELETED");
        assertThat(thread(page, root).path("comment").path("content").isNull()).isTrue();
        assertThat(replyIds(thread(page, root))).containsExactly(reply);

        // DELETED is a final status: it cannot be shown again or hidden.
        f.assertError(f.moderate(root, "VISIBLE"), 409, "RESOURCE_CONFLICT");
        f.assertError(f.moderate(root, "HIDDEN"), 409, "RESOURCE_CONFLICT");
        assertThat(f.row(root).get("status")).isEqualTo("DELETED");

        // A comment the author deleted is the same.
        UUID selfDeleted = f.createdId(f.create(an, post, "Author deletes own comment"));
        f.remove(an, selfDeleted).andExpect(status().isNoContent());
        f.assertError(f.moderate(selfDeleted, "VISIBLE"), 409, "RESOURCE_CONFLICT");
        f.adminDelete(selfDeleted).andExpect(status().isNoContent());

        // Still in the moderation list, with its content.
        JsonNode listed = f.body(f.adminList("q", f.suffix, "status", "DELETED").andExpect(status().isOk()));
        assertThat(ids(listed)).containsExactly(selfDeleted, hidden, root);
        assertThat(item(listed, root).path("content").asString()).isEqualTo("Root to be deleted by the admin");
    }

    @Test
    void can_moderate_comments_on_unpublished_post_too() throws Exception {
        Post post = f.publishedPost("Post to be unpublished");
        Reader an = f.reader("an");
        UUID id = f.createdId(f.create(an, post, "Comment on a post about to be unpublished"));
        f.unpublish(post);

        JsonNode hidden = f.data(f.moderate(id, "HIDDEN").andExpect(status().isOk()));
        assertThat(hidden.path("status").asString()).isEqualTo("HIDDEN");
        assertThat(hidden.path("postStatus").asString()).isEqualTo("DRAFT");
        f.moderate(id, "VISIBLE").andExpect(status().isOk());
        f.adminDelete(id).andExpect(status().isNoContent());

        assertThat(f.row(id).get("status")).isEqualTo("DELETED");
    }

    @Test
    void unknown_id_is_404_while_malformed_id_or_invalid_status_is_400_and_nothing_changes() throws Exception {
        Post post = f.publishedPost("Moderation errors");
        Reader an = f.reader("an");
        UUID id = f.createdId(f.create(an, post, "Comment to try errors on"));
        UUID unknown = UUID.randomUUID();
        String admin = auth.bearerForAdmin();

        f.assertError(f.moderate(unknown, "HIDDEN"), 404, "COMMENT_NOT_FOUND");
        f.assertError(f.moderate(unknown, "VISIBLE"), 404, "COMMENT_NOT_FOUND");
        f.assertError(f.adminDelete(unknown), 404, "COMMENT_NOT_FOUND");

        f.assertError(
                mockMvc.perform(patch("/api/v1/admin/comments/khong-phai-uuid/status")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"status\":\"HIDDEN\"}")),
                400,
                "VALIDATION_ERROR");
        f.assertError(
                mockMvc.perform(delete("/api/v1/admin/comments/khong-phai-uuid").header("Authorization", admin)),
                400,
                "VALIDATION_ERROR");

        // Delete has its own path (DELETE): PATCH only hides or unhides.
        f.assertError(f.moderate(id, "DELETED"), 400, "VALIDATION_ERROR");
        for (String body :
                List.of("{\"status\":\"hidden\"}", "{\"status\":\"BANNED\"}", "{}", "{\"status\":null}", "not JSON")) {
            f.assertError(
                    mockMvc.perform(patch("/api/v1/admin/comments/" + id + "/status")
                            .header("Authorization", admin)
                            .contentType(APPLICATION_JSON)
                            .content(body)),
                    400,
                    "VALIDATION_ERROR");
        }

        Map<String, Object> row = f.row(id);
        assertThat(row.get("status")).isEqualTo("VISIBLE");
        assertThat(row.get("content")).isEqualTo("Comment to try errors on");
    }

    @Test
    void only_admin_can_moderate_while_author_and_reader_get_403() throws Exception {
        Post post = f.publishedPost("Moderation permissions");
        Reader an = f.reader("an");
        UUID id = f.createdId(f.create(an, post, "Nobody but the admin can hide"));
        String author = auth.bearerFor(auth.createAuthor("kiem-duyet-" + f.suffix + "@blog.local"));

        for (String bearer : List.of(author, an.bearer())) {
            f.assertError(
                    mockMvc.perform(get("/api/v1/admin/comments").header("Authorization", bearer)), 403, "FORBIDDEN");
            f.assertError(f.moderate(bearer, id, "HIDDEN"), 403, "FORBIDDEN");
            f.assertError(
                    mockMvc.perform(delete("/api/v1/admin/comments/" + id).header("Authorization", bearer)),
                    403,
                    "FORBIDDEN");
        }
        f.assertError(mockMvc.perform(get("/api/v1/admin/comments")), 401, "UNAUTHENTICATED");
        f.assertError(f.moderate(null, id, "HIDDEN"), 401, "UNAUTHENTICATED");

        assertThat(f.row(id).get("status")).isEqualTo("VISIBLE");
    }

    // --- Helpers ---------------------------------------------------------------------------------------

    /** The posts and users tables in a Hibernate SQL statement, with their alias. */
    private static final Pattern POSTS = Pattern.compile("\\bposts\\s+(\\w+)");

    private static final Pattern USERS = Pattern.compile("\\busers\\s+(\\w+)");

    /** The columns a SQL statement reads through the alias of the {@code table} table; empty if it lacks that table. */
    private static Set<String> columnsOf(String sql, Pattern table) {
        Set<String> columns = new HashSet<>();
        Matcher alias = table.matcher(sql);
        while (alias.find()) {
            Matcher column = Pattern.compile("\\b" + Pattern.quote(alias.group(1)) + "\\.(\\w+)")
                    .matcher(sql);
            while (column.find()) {
                columns.add(column.group(1));
            }
        }
        return columns;
    }

    private interface Request {
        void run() throws Exception;
    }

    /**
     * Every SQL statement Hibernate sends while {@code request} runs: the {@code org.hibernate.SQL} logger
     * writes each one at DEBUG level, so that level is turned on around the request and then restored. Tests
     * run sequentially so no other statement slips in.
     */
    private static List<String> sqlDuring(Request request) throws Exception {
        Logger sql = (Logger) LoggerFactory.getLogger("org.hibernate.SQL");
        Level before = sql.getLevel();
        ListAppender<ILoggingEvent> captured = new ListAppender<>();
        captured.start();
        sql.addAppender(captured);
        sql.setLevel(Level.DEBUG);
        try {
            request.run();
        } finally {
            sql.setLevel(before);
            sql.detachAppender(captured);
        }
        return captured.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
    }

    private List<UUID> listIds(String... params) throws Exception {
        return ids(f.body(f.adminList(params).andExpect(status().isOk())));
    }

    private static List<UUID> ids(JsonNode body) {
        List<UUID> ids = new ArrayList<>();
        body.path("data")
                .forEach(item -> ids.add(UUID.fromString(item.path("id").asString())));
        return ids;
    }

    private static JsonNode item(JsonNode body, UUID id) {
        for (JsonNode item : body.path("data")) {
            if (id.toString().equals(item.path("id").asString())) {
                return item;
            }
        }
        throw new AssertionError("Comment not visible " + id + " in the list");
    }

    private static void assertPagination(JsonNode body, int page, int size, long totalElements, int totalPages) {
        JsonNode pagination = body.path("pagination");
        assertThat(pagination.path("page").asInt()).as("page").isEqualTo(page);
        assertThat(pagination.path("size").asInt()).as("size").isEqualTo(size);
        assertThat(pagination.path("totalElements").asLong())
                .as("totalElements")
                .isEqualTo(totalElements);
        assertThat(pagination.path("totalPages").asInt()).as("totalPages").isEqualTo(totalPages);
    }
}
