package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.post.service.PostService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.stream.IntStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The "Featured posts" order: {@code PUT /api/v1/admin/posts/featured-order} replaces every rank. The i-th post of the
 * list becomes featured with rank i; other posts keep their {@code featured} flag and only lose their rank. This command never
 * unfeatures a post: unfeaturing stays a separate per-post action, and it clears the rank as well.
 *
 * Every request goes through the real filter chain with a real token, like SeriesIT.
 *
 * The DB is shared and never cleaned. Ranks are a site-wide resource (unique across the whole table), and every
 * ordering clears all old ranks, so after one test's ordering command, ranks 1..n belong to that test: checking that "the
 * public featured list STARTS with the test's posts" is safe. Every other list is only checked within the test's own
 * category (random suffix), or checks "present"/"absent" and relative order, never length. Each test
 * ranks at most 5 posts and gives the ranks back when done (see {@link #releaseRanks}). Post text avoids every word that
 * PostSearchAndFeaturedIT searches for.
 */
@AutoConfigureMockMvc
class FeaturedOrderIT extends AbstractIntegrationTest {

    private static final String FEATURED_ORDER = "/api/v1/admin/posts/featured-order";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PostService postService;

    @Autowired
    private PlatformTransactionManager transactionManager;

    private String admin;
    private String suffix;
    private UUID categoryId;
    private String categorySlug;
    private final List<UUID> created = new ArrayList<>();

    /** A post of the test: the id to rank; the slug to read its public page. */
    private record Fixture(UUID id, String slug) {}

    @BeforeEach
    void setUp() throws Exception {
        admin = auth.bearerForAdmin();
        suffix = UUID.randomUUID().toString().substring(0, 8);
        JsonNode category = data(mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"name\":\"Ranked category " + UUID.randomUUID() + "\"}"))
                .andExpect(status().isCreated()));
        categoryId = UUID.fromString(category.path("id").asString());
        categorySlug = category.path("slug").asString();
    }

    /**
     * Gives back the ranks the test held. {@code ?featured=true} puts ranked posts first, so leaving them would put these posts at the head
     * of the featured list of every test that runs later. Touches only the test's own posts; {@code featured} stays as it is.
     */
    @AfterEach
    void releaseRanks() {
        created.forEach(id -> jdbcTemplate.update("UPDATE posts SET featured_rank = NULL WHERE id = ?", id));
    }

    // --- Setting the order --------------------------------------------------------------------------

    @Test
    void setting_order_c_a_b_gives_ranks_1_2_3_everywhere_and_public_featured_list_starts_with_c_a_b()
            throws Exception {
        Fixture a = publish(createPost("Ranked post A"));
        Fixture b = publish(createPost("Ranked post B"));
        Fixture c = publish(createPost("Ranked post C"));
        // Control: no post is selected yet; the ordering command selects the posts in the list by itself.
        assertThat(adminPost(c).path("featured").asBoolean()).isFalse();

        JsonNode response = data(setOrder(ids(c, a, b)).andExpect(status().isOk()));

        // The response is the featured list by rank; ranks 1..3 were just assigned, so these three posts come first.
        assertThat(idsOf(response)).startsWith(idOf(c), idOf(a), idOf(b));
        for (int i = 0; i < 3; i++) {
            JsonNode entry = response.get(i);
            assertThat(entry.path("featuredRank").asInt())
                    .as("element %d: featuredRank", i)
                    .isEqualTo(i + 1);
            assertThat(entry.path("featured").asBoolean())
                    .as("element %d: featured", i)
                    .isTrue();
            // The post summary like every list: it carries no post body.
            assertThat(entry.has("content")).as("element %d: content", i).isFalse();
        }
        // Read back on the admin page and on each post's public page.
        List<Fixture> expected = List.of(c, a, b);
        for (int i = 0; i < expected.size(); i++) {
            Fixture post = expected.get(i);
            assertThat(adminPost(post).path("featuredRank").asInt()).isEqualTo(i + 1);
            assertThat(adminPost(post).path("featured").asBoolean()).isTrue();
            assertThat(publicPost(post).path("featuredRank").asInt()).isEqualTo(i + 1);
        }
        // The site-wide public featured list starts with exactly that order, and in the test's category there are only
        // these three posts, by rank and not by publish date (C was published last yet comes first; B comes last).
        assertThat(publicIds("featured=true")).startsWith(idOf(c), idOf(a), idOf(b));
        assertThat(publicIds("featured=true&category=" + categorySlug)).containsExactly(idOf(c), idOf(a), idOf(b));
    }

    @Test
    void featured_post_missing_from_list_stays_featured_only_loses_rank_and_comes_after_ranked_posts()
            throws Exception {
        Fixture first = publish(createPost("Post that moves to the top"));
        Fixture second = publish(createPost("Post in second place"));
        Fixture dropped = publish(createPost("Post dropped from the order"));
        Fixture plain = publish(createPost("Post nobody picked"));
        setOrder(ids(second, dropped)).andExpect(status().isOk());
        assertThat(adminPost(dropped).path("featuredRank").asInt()).isEqualTo(2);

        JsonNode response = data(setOrder(ids(first, second)).andExpect(status().isOk()));

        assertThat(idsOf(response)).startsWith(idOf(first), idOf(second));
        // The post that just fell out of the list is still featured, only loses its rank, and comes after every ranked
        // post.
        JsonNode droppedEntry = findById(response, dropped);
        assertThat(droppedEntry.path("featured").asBoolean()).isTrue();
        assertThat(droppedEntry.path("featuredRank").isNull()).isTrue();
        assertThat(idsOf(response).indexOf(idOf(dropped))).isGreaterThan(1);
        JsonNode droppedDetail = adminPost(dropped);
        assertThat(droppedDetail.path("featured").asBoolean()).isTrue();
        assertThat(droppedDetail.path("featuredRank").isNull()).isTrue();
        // A post that was never selected is not touched by this command.
        assertThat(adminPost(plain).path("featured").asBoolean()).isFalse();
        assertThat(idsOf(response)).doesNotContain(idOf(plain));

        assertThat(publicIds("featured=true&category=" + categorySlug))
                .containsExactly(idOf(first), idOf(second), idOf(dropped));
    }

    @Test
    void response_includes_featured_posts_of_every_status_while_public_view_shows_only_published() throws Exception {
        Fixture rankedDraft = createPost("Ranked draft");
        Fixture rankedPublished = publish(createPost("Ranked published post"));
        Fixture unrankedPublished = feature(publish(createPost("Unranked published post")));
        Fixture olderDraft = feature(createPost("Unranked draft created earlier"));
        Fixture newerDraft = feature(createPost("Unranked draft created later"));

        JsonNode response = data(setOrder(ids(rankedDraft, rankedPublished)).andExpect(status().isOk()));

        // A draft is ranked like any post: the admin page needs to see it in the right place before it is published.
        assertThat(idsOf(response)).startsWith(idOf(rankedDraft), idOf(rankedPublished));
        assertThat(response.get(0).path("status").asString()).isEqualTo("DRAFT");
        assertThat(response.get(0).path("featuredRank").asInt()).isEqualTo(1);
        // Unranked posts: the published one first, the draft (no publish date) last, the newly created draft before the
        // older one.
        List<String> order = idsOf(response);
        assertThat(order).contains(idOf(unrankedPublished), idOf(olderDraft), idOf(newerDraft));
        assertThat(order.indexOf(idOf(rankedPublished))).isLessThan(order.indexOf(idOf(unrankedPublished)));
        assertThat(order.indexOf(idOf(unrankedPublished))).isLessThan(order.indexOf(idOf(newerDraft)));
        assertThat(order.indexOf(idOf(newerDraft))).isLessThan(order.indexOf(idOf(olderDraft)));

        // The public view shows only published posts, still by rank.
        assertThat(publicIds("featured=true&category=" + categorySlug))
                .containsExactly(idOf(rankedPublished), idOf(unrankedPublished));
        // Publish the draft: it appears at once at the rank it was given.
        publish(rankedDraft);
        assertThat(publicIds("featured=true&category=" + categorySlug))
                .containsExactly(idOf(rankedDraft), idOf(rankedPublished), idOf(unrankedPublished));
    }

    // --- feature / unfeature -----------------------------------------------------------------------

    @Test
    void unfeaturing_clears_rank_reselecting_does_not_restore_it_and_selecting_a_ranked_post_keeps_its_rank()
            throws Exception {
        Fixture a = publish(createPost("Post to be unpicked"));
        Fixture b = publish(createPost("Post keeping its rank"));
        setOrder(ids(a, b)).andExpect(status().isOk());

        // Unfeaturing a ranked post: the rank goes in the same statement (a CHECK constraint forbids an unfeatured post
        // keeping a rank).
        JsonNode unfeatured = data(mockMvc.perform(
                        post("/api/v1/admin/posts/" + a.id() + "/unfeature").header("Authorization", admin))
                .andExpect(status().isOk()));
        assertThat(unfeatured.path("featured").asBoolean()).isFalse();
        assertThat(unfeatured.path("featuredRank").isNull()).isTrue();
        Map<String, Object> row =
                jdbcTemplate.queryForMap("SELECT featured, featured_rank FROM posts WHERE id = ?", a.id());
        assertThat(row).containsEntry("featured", false);
        assertThat(row.get("featured_rank")).isNull();
        // Other posts are not renumbered.
        assertThat(adminPost(b).path("featuredRank").asInt()).isEqualTo(2);
        assertThat(publicIds("featured=true&category=" + categorySlug)).containsExactly(idOf(b));

        // Select again: selected but does not get its old rank back, so it comes after the ranked posts.
        JsonNode refeatured = data(mockMvc.perform(
                        post("/api/v1/admin/posts/" + a.id() + "/feature").header("Authorization", admin))
                .andExpect(status().isOk()));
        assertThat(refeatured.path("featured").asBoolean()).isTrue();
        assertThat(refeatured.path("featuredRank").isNull()).isTrue();
        // Selecting a post that already has a rank: idempotent, the rank stays.
        JsonNode stillRanked = data(mockMvc.perform(
                        post("/api/v1/admin/posts/" + b.id() + "/feature").header("Authorization", admin))
                .andExpect(status().isOk()));
        assertThat(stillRanked.path("featured").asBoolean()).isTrue();
        assertThat(stillRanked.path("featuredRank").asInt()).isEqualTo(2);

        assertThat(publicIds("featured=true&category=" + categorySlug)).containsExactly(idOf(b), idOf(a));
    }

    @Test
    void ordering_selecting_and_unselecting_do_not_change_updatedAt_but_editing_the_post_does() throws Exception {
        Fixture a = publish(createPost("Post keeping its edit date"));
        Fixture b = publish(createPost("Neighbor post keeping its edit date"));
        JsonNode before = adminPost(a);
        Instant updatedBefore = Instant.parse(before.path("updatedAt").asString());

        setOrder(ids(a, b)).andExpect(status().isOk());
        setOrder(ids(b, a)).andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/admin/posts/" + a.id() + "/unfeature").header("Authorization", admin))
                .andExpect(status().isOk());
        feature(a);

        // Ordering "Featured posts", selecting and unselecting are editorial work, not post edits: updatedAt is
        // the dateModified of ArticleJsonLd, and must not jump every time the site owner reorders the list.
        assertThat(updatedAt(a)).isEqualTo(updatedBefore);

        // Control: a real post edit does move updatedAt, so the comparison above is not on a field that never changes.
        Map<String, Object> body = Map.of(
                "title", before.path("title").asString() + " (edited)",
                "excerpt", before.path("excerpt").asString(),
                "content", before.path("content").asString(),
                "categoryId", categoryId.toString(),
                "tagIds", List.of(),
                "slug", before.path("slug").asString());
        mockMvc.perform(put("/api/v1/admin/posts/" + a.id())
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isOk());
        assertThat(updatedAt(a)).isAfter(updatedBefore);
    }

    @Test
    void only_featured_true_sorts_by_rank_while_featured_false_still_means_no_filter() throws Exception {
        Fixture older = publish(createPost("Post published first"));
        Fixture newer = publish(createPost("Post published later"));
        Fixture plain = publish(createPost("Last published post not picked"));
        // Fixed publish dates, a day apart: the order does not depend on the clock's resolution.
        setPublishedAt(older, "2001-01-01T00:00:00Z");
        setPublishedAt(newer, "2001-01-02T00:00:00Z");
        setPublishedAt(plain, "2001-01-03T00:00:00Z");
        setOrder(ids(older, newer)).andExpect(status().isOk());

        // featured=true: by rank, an older post still comes first.
        assertThat(publicIds("featured=true&category=" + categorySlug)).containsExactly(idOf(older), idOf(newer));
        // No featured, or featured=false: every post, newest first; ranks do not change the order here.
        List<String> newestFirst = List.of(idOf(plain), idOf(newer), idOf(older));
        assertThat(publicIds("category=" + categorySlug)).containsExactlyElementsOf(newestFirst);
        assertThat(publicIds("featured=false&category=" + categorySlug)).containsExactlyElementsOf(newestFirst);
    }

    // --- Two tabs saving at once -------------------------------------------------------------------

    @Test
    void two_overlapping_saves_of_different_orders_make_the_second_wait_then_win_completely() throws Exception {
        Fixture x = publish(createPost("Post ranked by both tabs"));
        Fixture y = publish(createPost("Post ranked by the first tab only"));
        Fixture z = publish(createPost("Post ranked by the second tab only"));
        // The state committed before the two tabs save: only x has a rank.
        setOrder(ids(x)).andExpect(status().isOk());

        CountDownLatch firstHoldsOrder = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            // The first tab is saving [x, y]: the real ordering command has finished inside an uncommitted transaction.
            Future<?> first =
                    pool.submit(() -> new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                        postService.setFeaturedOrder(ids(x, y));
                        firstHoldsOrder.countDown();
                        awaitQuietly(releaseFirst);
                    }));
            assertThat(firstHoldsOrder.await(10, TimeUnit.SECONDS)).isTrue();

            // The second tab saves [z, x] right then.
            Future<MvcResult> second = pool.submit(() -> setOrder(ids(z, x)).andReturn());
            // Control that the two saves really overlap: the second is waiting, not finished.
            assertThatThrownBy(() -> second.get(500, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
            releaseFirst.countDown();
            first.get(10, TimeUnit.SECONDS);
            MvcResult result = second.get(30, TimeUnit.SECONDS);

            // Without locking the whole command the second clears ranks from a snapshot taken BEFORE the first
            // committed: y's rank 2 (the first
            // just assigned it) survives, then giving x rank 2 hits the unique constraint as a 409. The second must win
            // completely: exactly
            // [z, x], with y still selected but no longer ranked, like any post a new list does not mention.
            assertThat(result.getResponse().getStatus())
                    .as(result.getResponse().getContentAsString())
                    .isEqualTo(200);
            assertThat(adminPost(z).path("featuredRank").asInt()).isEqualTo(1);
            assertThat(adminPost(x).path("featuredRank").asInt()).isEqualTo(2);
            JsonNode yDetail = adminPost(y);
            assertThat(yDetail.path("featured").asBoolean()).isTrue();
            assertThat(yDetail.path("featuredRank").isNull()).isTrue();
        } finally {
            releaseFirst.countDown();
            pool.shutdownNow();
        }
    }

    // --- Errors ------------------------------------------------------------------------------------

    @Test
    void unknown_post_id_is_400_POST_NOT_FOUND_and_old_order_is_kept() throws Exception {
        Fixture a = publish(createPost("First-rank post kept"));
        Fixture b = publish(createPost("Second-rank post kept"));
        setOrder(ids(a, b)).andExpect(status().isOk());

        // The unknown id is LAST: by the time it is hit, every rank has been cleared and B has been given rank 1. The
        // whole write must roll back.
        assertError(setOrder(List.of(b.id(), UUID.randomUUID())), 400, "POST_NOT_FOUND");

        assertThat(adminPost(a).path("featuredRank").asInt()).isEqualTo(1);
        assertThat(adminPost(b).path("featuredRank").asInt()).isEqualTo(2);
    }

    @Test
    void invalid_body_or_duplicate_id_is_400_VALIDATION_ERROR_while_empty_list_clears_every_rank() throws Exception {
        Fixture a = publish(createPost("First-rank post before the error"));
        Fixture b = publish(createPost("Second-rank post before the error"));
        setOrder(ids(a, b)).andExpect(status().isOk());

        // A post cannot hold two ranks.
        assertError(setOrder(ids(b, b)), 400, "VALIDATION_ERROR");
        assertError(putOrder("{}", admin), 400, "VALIDATION_ERROR");
        assertError(putOrder("{\"postIds\":[null]}", admin), 400, "VALIDATION_ERROR");
        assertError(putOrder("{\"postIds\":[\"khong-phai-uuid\"]}", admin), 400, "VALIDATION_ERROR");
        List<UUID> tooMany =
                IntStream.range(0, 51).mapToObj(i -> UUID.randomUUID()).toList();
        assertError(setOrder(tooMany), 400, "VALIDATION_ERROR");
        // None of the calls above touched the order.
        assertThat(adminPost(a).path("featuredRank").asInt()).isEqualTo(1);
        assertThat(adminPost(b).path("featuredRank").asInt()).isEqualTo(2);

        // Control: an empty list is valid. It clears every rank without unselecting any post.
        setOrder(List.of()).andExpect(status().isOk());
        for (Fixture post : List.of(a, b)) {
            JsonNode detail = adminPost(post);
            assertThat(detail.path("featured").asBoolean()).isTrue();
            assertThat(detail.path("featuredRank").isNull()).isTrue();
        }
    }

    @Test
    void only_admin_can_set_order_author_gets_403_even_for_own_posts_and_no_token_gets_401() throws Exception {
        Fixture ranked = publish(createPost("Admin ranked post"));
        // Control: admin can set it.
        setOrder(ids(ranked)).andExpect(status().isOk());
        String author = auth.bearerFor(auth.createAuthor("featured-order-" + suffix + "@blog.local"));
        Fixture own = createPost("Author post", author);

        // The order is site-wide, spanning posts of every author: an AUTHOR cannot set it, even with only their own
        // posts.
        String body = objectMapper.writeValueAsString(Map.of("postIds", ids(own)));
        assertError(putOrder(body, author), 403, "FORBIDDEN");
        assertError(
                mockMvc.perform(
                        put(FEATURED_ORDER).contentType(APPLICATION_JSON).content(body)),
                401,
                "UNAUTHENTICATED");

        // None of the calls above touched the order or any author's post.
        assertThat(adminPost(ranked).path("featuredRank").asInt()).isEqualTo(1);
        JsonNode ownDetail = adminPost(own);
        assertThat(ownDetail.path("featured").asBoolean()).isFalse();
        assertThat(ownDetail.path("featuredRank").isNull()).isTrue();
    }

    // --- Checks ------------------------------------------------------------------------------------

    private void assertError(ResultActions result, int status, String code) throws Exception {
        result.andExpect(status().is(status));
        JsonNode error = objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("error");
        assertThat(error.path("code").asString()).isEqualTo(code);
    }

    // --- Reading -----------------------------------------------------------------------------------

    private JsonNode adminPost(Fixture post) throws Exception {
        return data(mockMvc.perform(get("/api/v1/admin/posts/" + post.id()).header("Authorization", admin))
                .andExpect(status().isOk()));
    }

    /** Reads back from the DB through the admin page, not from the write's response (an in-memory value, not yet rounded). */
    private Instant updatedAt(Fixture post) throws Exception {
        return Instant.parse(adminPost(post).path("updatedAt").asString());
    }

    private JsonNode publicPost(Fixture post) throws Exception {
        return data(mockMvc.perform(get("/api/v1/posts/" + post.slug())).andExpect(status().isOk()));
    }

    /** Ids of the posts in the public list, without a token, in returned order. */
    private List<String> publicIds(String query) throws Exception {
        return idsOf(
                data(mockMvc.perform(get("/api/v1/posts?" + query + "&size=50")).andExpect(status().isOk())));
    }

    private static List<String> idsOf(JsonNode array) {
        List<String> ids = new ArrayList<>();
        array.forEach(node -> ids.add(node.path("id").asString()));
        return ids;
    }

    private static JsonNode findById(JsonNode array, Fixture post) {
        for (JsonNode node : array) {
            if (idOf(post).equals(node.path("id").asString())) {
                return node;
            }
        }
        throw new AssertionError("Post not found: " + post.slug() + " in the list");
    }

    private static String idOf(Fixture post) {
        return post.id().toString();
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("data");
    }

    // --- Ghi ---------------------------------------------------------------------------------------

    private ResultActions setOrder(List<UUID> postIds) throws Exception {
        return putOrder(objectMapper.writeValueAsString(Map.of("postIds", postIds)), admin);
    }

    private ResultActions putOrder(String json, String bearer) throws Exception {
        return mockMvc.perform(put(FEATURED_ORDER)
                .header("Authorization", bearer)
                .contentType(APPLICATION_JSON)
                .content(json));
    }

    private static List<UUID> ids(Fixture... posts) {
        return Arrays.stream(posts).map(Fixture::id).toList();
    }

    private Fixture createPost(String title) throws Exception {
        return createPost(title, admin);
    }

    private Fixture createPost(String title, String bearer) throws Exception {
        String payload = objectMapper.writeValueAsString(Map.of(
                "title",
                title + " " + suffix,
                "excerpt",
                "Summary " + suffix,
                "content",
                String.join(" ", Collections.nCopies(12, "word")),
                "categoryId",
                categoryId.toString()));
        JsonNode node = data(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", bearer)
                        .contentType(APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated()));
        Fixture fixture = new Fixture(
                UUID.fromString(node.path("id").asString()), node.path("slug").asString());
        created.add(fixture.id());
        return fixture;
    }

    private Fixture publish(Fixture post) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + post.id() + "/publish").header("Authorization", admin))
                .andExpect(status().isOk());
        return post;
    }

    private Fixture feature(Fixture post) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + post.id() + "/feature").header("Authorization", admin))
                .andExpect(status().isOk());
        return post;
    }

    private static void awaitQuietly(CountDownLatch latch) {
        try {
            latch.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void setPublishedAt(Fixture post, String instant) {
        assertThat(jdbcTemplate.update(
                        "UPDATE posts SET published_at = ? WHERE id = ?",
                        Timestamp.from(Instant.parse(instant)),
                        post.id()))
                .isEqualTo(1);
    }
}
