package com.blog.bookmark;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.comment.CommentFixtures;
import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.HeldTransaction;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Bookmark: {@code /api/v1/me/bookmarks}. Each test creates its own fresh reader: the shared
 * DB is never cleaned, and the limit of 30 saves and unsaves per minute per person lives in the in-memory
 * state of the shared context. Suspended users: UserSuspensionIT; permission matrix: SecurityMatrixIT;
 * merging: AdminGithubLinkIT.
 */
@AutoConfigureMockMvc
class BookmarkIT extends AbstractIntegrationTest {

    private static final String BOOKMARKS = "/api/v1/me/bookmarks";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private PlatformTransactionManager transactionManager;

    private CommentFixtures f;

    @BeforeEach
    void setUp() {
        f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
    }

    // --- V29 schema -----------------------------------------------------------------------------------------------

    @Test
    void schema_v29_one_row_per_user_and_post_two_cascading_foreign_keys_and_index_by_post() {
        assertThat(jdbcTemplate.queryForList(
                        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                                + "WHERE conrelid = 'post_bookmarks'::regclass AND contype IN ('p', 'f')",
                        String.class))
                .containsExactlyInAnyOrder(
                        "PRIMARY KEY (user_id, post_id)",
                        "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
                        "FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE");
        assertThat(jdbcTemplate.queryForList(
                        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' "
                                + "AND tablename = 'post_bookmarks' AND indexname = 'idx_post_bookmarks_post_id'",
                        String.class))
                .containsExactly(
                        "CREATE INDEX idx_post_bookmarks_post_id ON public.post_bookmarks USING btree (post_id)");
    }

    // --- Save, list, unsave --------------------------------------------------------------------------------------

    @Test
    void save_resave_unsave_reunsave_all_200_with_server_state_and_exactly_one_row() throws Exception {
        Post post = f.publishedPost("Bookmarked post");
        Reader an = f.reader("an");

        assertState(bookmark(an, post, "GET"), false);
        assertState(bookmark(an, post, "PUT"), true);
        // Save again: still one row, still 200.
        assertState(bookmark(an, post, "PUT"), true);
        assertThat(rows(an)).isEqualTo(1);
        assertState(bookmark(an, post, "GET"), true);
        assertThat(slugs(list(an))).containsExactly(post.slug());

        assertState(bookmark(an, post, "DELETE"), false);
        // Unsave again: still 200.
        assertState(bookmark(an, post, "DELETE"), false);
        assertState(bookmark(an, post, "GET"), false);
        assertThat(rows(an)).isZero();
        assertThat(slugs(list(an))).isEmpty();
    }

    @Test
    void list_newest_saved_first_ties_by_post_id_page_size_clamped_1_to_50_and_correct_total() throws Exception {
        Reader an = f.reader("danh-sach");
        List<Post> posts = new ArrayList<>();
        for (int i = 1; i <= 3; i++) {
            Post post = f.publishedPost("Bookmarked post number " + i);
            assertState(bookmark(an, post, "PUT"), true);
            posts.add(post);
        }

        JsonNode first = list(an, "size", "2");
        assertThat(slugs(first))
                .containsExactly(posts.get(2).slug(), posts.get(1).slug());
        assertPagination(first, 0, 2, 3, 2);
        JsonNode second = list(an, "page", "1", "size", "2");
        assertThat(slugs(second)).containsExactly(posts.get(0).slug());
        assertPagination(second, 1, 2, 3, 2);
        // Default size 20, clamped to 1..50; a negative page is the first page.
        assertPagination(list(an), 0, 20, 3, 1);
        assertPagination(list(an, "size", "0"), 0, 1, 3, 3);
        assertPagination(list(an, "size", "1000"), 0, 50, 3, 1);
        assertPagination(list(an, "page", "-1"), 0, 20, 3, 1);

        // Saved at the same instant: the larger post id comes first, so the next page neither repeats nor
        // skips posts. Re-written in ascending id order (physical order and primary key) so that only that
        // tie-breaker yields the descending order. The hex strings are Postgres uuid order.
        List<Post> byId = posts.stream()
                .sorted(Comparator.comparing((Post post) -> post.id().toString()))
                .toList();
        jdbcTemplate.update("DELETE FROM post_bookmarks WHERE user_id = ?", an.id());
        for (Post post : byId) {
            jdbcTemplate.update(
                    "INSERT INTO post_bookmarks (user_id, post_id, created_at) "
                            + "VALUES (?, ?, '2026-01-01T00:00:00Z')",
                    an.id(),
                    post.id());
        }
        assertThat(slugs(list(an)))
                .containsExactlyElementsOf(
                        byId.reversed().stream().map(Post::slug).toList());
    }

    // --- Each user sees only their own -----------------------------------------------------------------------------

    @Test
    void other_users_cannot_see_or_unsave_my_bookmark_even_when_claiming_my_id_and_guests_get_401() throws Exception {
        Post post = f.publishedPost("Post bookmarked privately by An");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        assertState(bookmark(an, post, "PUT"), true);
        String anId = an.id().toString();

        assertThat(slugs(list(binh))).isEmpty();
        assertPagination(list(binh, "userId", anId), 0, 20, 0, 0);
        assertState(bookmark(binh, post, "GET"), false);
        // Unsave only touches the token owner's row, even if the query claims to be An.
        assertState(perform(delete(BOOKMARKS + "/" + post.slug()).param("userId", anId), binh), false);
        assertState(bookmark(an, post, "GET"), true);
        // The post An saved was later taken down: for Binh it is just a draft, so unsaving is 404 like an
        // unknown slug.
        Post hidden = f.publishedPost("Post bookmarked by An then unpublished");
        assertState(bookmark(an, hidden, "PUT"), true);
        f.unpublish(hidden);
        f.assertError(bookmark(binh, hidden, "DELETE"), 404, "POST_NOT_FOUND");
        assertThat(rows(an)).isEqualTo(2);

        for (String method : List.of("GET", "PUT", "DELETE")) {
            f.assertError(bookmark(null, post, method), 401, "UNAUTHENTICATED");
        }
        f.assertError(mockMvc.perform(get(BOOKMARKS)), 401, "UNAUTHENTICATED");
        assertThat(jdbcTemplate.queryForList(
                        "SELECT user_id FROM post_bookmarks WHERE post_id = ?", UUID.class, post.id()))
                .containsExactly(an.id());
    }

    // --- Unknown post, draft, taken-down post, deleted post ------------------------------------------------

    @Test
    void
            unknown_slug_and_draft_are_404_unpublished_post_hidden_from_list_still_unsavable_and_reappears_when_republished()
                    throws Exception {
        Reader an = f.reader("chinh-sach");
        Post draft = f.draftPost("Draft cannot be bookmarked");
        Post unknown = new Post(null, "khong-co-bai-nay-" + f.suffix);
        for (Post post : List.of(draft, unknown)) {
            for (String method : List.of("GET", "PUT", "DELETE")) {
                f.assertError(bookmark(an, post, method), 404, "POST_NOT_FOUND");
            }
        }
        assertThat(rows(an)).isZero();

        Post republished = f.publishedPost("Post unpublished then republished");
        Post removed = f.publishedPost("Post unpublished then unbookmarked");
        Post live = f.publishedPost("Post still published");
        for (Post post : List.of(republished, removed, live)) {
            assertState(bookmark(an, post, "PUT"), true);
        }
        f.unpublish(republished);
        f.unpublish(removed);

        // Taken down: the row remains, but it is in neither the page nor the total; viewing and saving are
        // 404 like a draft.
        JsonNode page = list(an);
        assertThat(slugs(page)).containsExactly(live.slug());
        assertPagination(page, 0, 20, 1, 1);
        f.assertError(bookmark(an, republished, "GET"), 404, "POST_NOT_FOUND");
        f.assertError(bookmark(an, republished, "PUT"), 404, "POST_NOT_FOUND");
        assertThat(rows(an)).isEqualTo(3);
        // A taken-down post can be unsaved, so it does not reappear when the post is republished. The second
        // time, that slug is no longer a published post or one this user saved: 404 like a draft.
        assertState(bookmark(an, removed, "DELETE"), false);
        f.assertError(bookmark(an, removed, "DELETE"), 404, "POST_NOT_FOUND");

        f.republish(republished);
        f.republish(removed);
        assertThat(slugs(list(an))).containsExactly(live.slug(), republished.slug());
        assertState(bookmark(an, republished, "GET"), true);
        assertState(bookmark(an, removed, "GET"), false);

        f.deletePost(republished);
        assertThat(rows(an)).isEqualTo(1);
        assertThat(slugs(list(an))).containsExactly(live.slug());
    }

    @Test
    void post_taken_down_just_before_save_leaves_no_bookmark_and_response_does_not_report_saved() throws Exception {
        Post post = f.publishedPost("Unpublish during a bookmark");
        Reader an = f.reader("dua");

        ExecutorService pool = Executors.newSingleThreadExecutor();
        // Lock post_bookmarks (SHARE): the save got past the post lookup and stops at the INSERT. The post is
        // taken down and committed meanwhile; the INSERT then runs with a fresh snapshot, so it selects no
        // post.
        try (HeldTransaction gate = new HeldTransaction(
                transactionManager, jdbcTemplate, jdbc -> jdbc.execute("LOCK TABLE post_bookmarks IN SHARE MODE"))) {
            Future<MockHttpServletResponse> saving =
                    pool.submit(() -> bookmark(an, post, "PUT").andReturn().getResponse());
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "INSERT INTO post_bookmarks", 1);
            f.unpublish(post);
            gate.commit();

            MockHttpServletResponse response = saving.get(30, TimeUnit.SECONDS);
            assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
            assertThat(objectMapper
                            .readTree(response.getContentAsString())
                            .path("data")
                            .path("bookmarked")
                            .asBoolean())
                    .isFalse();
        } finally {
            pool.shutdownNow();
        }

        assertThat(rows(an)).isZero();
    }

    // --- Rate limit ------------------------------------------------------------------------------------------------

    @Test
    void save_and_unsave_share_30_per_minute_per_user_limit_while_reads_are_unlimited() throws Exception {
        Post post = f.publishedPost("Bookmark and unbookmark repeatedly");
        Reader an = f.reader("gioi-han");
        Reader binh = f.reader("gioi-han-khac");

        for (int i = 0; i < 30; i++) {
            bookmark(an, post, i % 2 == 0 ? "PUT" : "DELETE").andExpect(status().isOk());
        }
        f.assertError(bookmark(an, post, "PUT"), 429, "RATE_LIMITED");
        f.assertError(bookmark(an, post, "DELETE"), 429, "RATE_LIMITED");

        // The blocked attempt writes nothing; reads are not limited; other users are unaffected.
        assertState(bookmark(an, post, "GET"), false);
        assertThat(slugs(list(an))).isEmpty();
        assertState(bookmark(binh, post, "PUT"), true);
    }

    // --- Nothing about bookmarks in the public API -----------------------------------------------------------------

    @Test
    void public_api_carries_nothing_about_bookmarks_and_saved_item_equals_public_item() throws Exception {
        Post post = f.publishedPost("Privately bookmarked post");
        Reader an = f.reader("rieng-tu");
        assertState(bookmark(an, post, "PUT"), true);

        // With or without the token of the user who saved it, the answer is the same, and no field mentions
        // bookmarks.
        for (String path : List.of(
                "/api/v1/posts/" + post.slug(), "/api/v1/posts?size=100", "/api/v1/posts/search?q=" + f.suffix)) {
            JsonNode anonymous = f.body(mockMvc.perform(get(path)).andExpect(status().isOk()));
            assertThat(f.body(perform(get(path), an))).as(path).isEqualTo(anonymous);
            assertThat(fieldNames(anonymous))
                    .as(path)
                    .noneMatch(name -> name.toLowerCase(Locale.ROOT).contains("bookmark"));
        }

        // The saved item equals the public search item: same fields, same values, nothing reader-specific
        // added.
        JsonNode found = f.body(mockMvc.perform(get("/api/v1/posts/search").param("q", f.suffix)))
                .path("data");
        assertThat(found).hasSize(1);
        assertThat(list(an).path("data")).containsExactly(found.get(0));
    }

    // --- Helpers -------------------------------------------------------------------------------------------------

    /** {@code GET} (state), {@code PUT} (save) or {@code DELETE} (unsave); a null {@code reader} means a guest. */
    private ResultActions bookmark(Reader reader, Post post, String method) throws Exception {
        String path = BOOKMARKS + "/" + post.slug();
        MockHttpServletRequestBuilder request = switch (method) {
            case "PUT" -> put(path);
            case "DELETE" -> delete(path);
            default -> get(path);
        };
        return perform(request, reader);
    }

    /** One page of saved items ({@code data}, {@code pagination}); fails if the status is not 200. */
    private JsonNode list(Reader reader, String... params) throws Exception {
        MockHttpServletRequestBuilder request = get(BOOKMARKS);
        for (int i = 0; i < params.length; i += 2) {
            request.param(params[i], params[i + 1]);
        }
        return f.body(perform(request, reader).andExpect(status().isOk()));
    }

    private ResultActions perform(MockHttpServletRequestBuilder request, Reader reader) throws Exception {
        return mockMvc.perform(reader == null ? request : request.header("Authorization", reader.bearer()));
    }

    /** 200 with exactly one field, {@code bookmarked}. */
    private void assertState(ResultActions result, boolean bookmarked) throws Exception {
        JsonNode state = f.data(result.andExpect(status().isOk()));
        assertThat(state.propertyNames()).containsExactly("bookmarked");
        assertThat(state.path("bookmarked").asBoolean())
                .as("bookmarked: %s", state)
                .isEqualTo(bookmarked);
    }

    private static void assertPagination(JsonNode page, int number, int size, long totalElements, int totalPages) {
        assertThat(page.path("pagination").toString())
                .isEqualTo(
                        "{\"page\":%d,\"size\":%d,\"totalElements\":%d," + "\"totalPages\":%d}",
                        number, size, totalElements, totalPages);
    }

    private static List<String> slugs(JsonNode page) {
        List<String> slugs = new ArrayList<>();
        page.path("data").forEach(item -> slugs.add(item.path("slug").asString()));
        return slugs;
    }

    /** Every field name, at every level. */
    private static List<String> fieldNames(JsonNode node) {
        List<String> names = new ArrayList<>();
        if (node.isObject()) {
            node.propertyNames().forEach(name -> {
                names.add(name);
                names.addAll(fieldNames(node.path(name)));
            });
        } else if (node.isArray()) {
            node.forEach(item -> names.addAll(fieldNames(item)));
        }
        return names;
    }

    private long rows(Reader reader) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM post_bookmarks WHERE user_id = ?", Long.class, reader.id());
    }
}
