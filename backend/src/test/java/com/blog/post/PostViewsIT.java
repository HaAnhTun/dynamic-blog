package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.io.InputStream;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockMultipartHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Views, the "most read" order and public stats: {@code POST /api/v1/posts/{slug}/views},
 * {@code GET /api/v1/posts?sort=latest|popular}, {@code GET /api/v1/stats}.
 *
 * Every public request goes without an Authorization header: the filter chain's fallback is denyAll, so "public" has to
 * be asserted, not assumed. The context runs with an empty {@code app.views.token}, like dev and compose; the branch with a
 * token is tested in PostViewServiceTest, not with a second context.
 *
 * The DB is shared and never cleaned: names carry a random suffix, views and stats are counted as differences, view counts
 * set by SQL are always larger than any existing counter, and no global list length is checked except the number of
 * published posts read from the DB itself. Fixture text avoids every word that PostSearchAndFeaturedIT searches for.
 */
@AutoConfigureMockMvc
class PostViewsIT extends AbstractIntegrationTest {

    private static final String SORT_MESSAGE = "sort must be 'latest' or 'popular'";
    private static final String FILTER_MESSAGE = "sort=popular cannot be combined with filters";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String admin;
    /** Random suffix for the names of this test's posts, series and images. */
    private String suffix;

    private UUID categoryId;
    private String categorySlug;

    private record Fixture(UUID id, String slug) {}

    @BeforeEach
    void setUp() throws Exception {
        admin = auth.bearerForAdmin();
        suffix = UUID.randomUUID().toString().substring(0, 8);
        JsonNode category = data(mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"name\":\"Category views " + UUID.randomUUID() + "\"}"))
                .andExpect(status().isCreated()));
        categoryId = UUID.fromString(category.path("id").asString());
        categorySlug = category.path("slug").asString();
    }

    // --- Counting views -------------------------------------------------------------------------------

    @Test
    void each_call_adds_exactly_one_view_returns_204_without_body_and_needs_no_login() throws Exception {
        Fixture post = publish(create("Viewed post"));
        long before = publicViewCount(post);

        // The first call creates the counter, later ones add to the existing counter: two branches of the same upsert.
        for (int i = 0; i < 2; i++) {
            String body = recordView(post.slug())
                    .andExpect(status().isNoContent())
                    .andReturn()
                    .getResponse()
                    .getContentAsString();
            assertThat(body).isEmpty();
        }

        assertThat(publicViewCount(post)).isEqualTo(before + 2);
        assertThat(storedViews(post)).isEqualTo(before + 2);
    }

    @Test
    void unpublished_post_taken_down_post_and_unknown_slug_are_404_and_count_nothing() throws Exception {
        Fixture unpublished = create("Unreleased post");
        Fixture withdrawn = publish(create("Post taken down"));
        // Control: while published, this post can be counted.
        recordView(withdrawn.slug()).andExpect(status().isNoContent());
        unpublish(withdrawn);

        assertError(recordView(unpublished.slug()), 404, "POST_NOT_FOUND");
        assertError(recordView(withdrawn.slug()), 404, "POST_NOT_FOUND");
        assertError(recordView("khong-co-bai-nay-" + suffix), 404, "POST_NOT_FOUND");

        // No counter is created for an unpublished post, and none is incremented for a taken-down post.
        assertThat(counterRows(unpublished)).isZero();
        assertThat(storedViews(withdrawn)).isEqualTo(1);
    }

    @Test
    void only_the_views_endpoint_is_open_to_anonymous_callers() throws Exception {
        Fixture post = publish(create("Open rule check post"));
        // Control: the open endpoint answers when there is no token.
        recordView(post.slug()).andExpect(status().isNoContent());

        // The rule is POST /api/v1/posts/*/views: exactly one slug segment and then "views". Any other POST under
        // /api/v1/posts
        // still falls to denyAll, so an anonymous caller gets 401 and never reaches a handler.
        for (String path : List.of(
                "/api/v1/posts/" + post.slug(),
                "/api/v1/posts/" + post.slug() + "/views/them",
                "/api/v1/posts/them/" + post.slug() + "/views")) {
            assertError(mockMvc.perform(post(path)), 401, "UNAUTHENTICATED");
        }
        assertThat(storedViews(post)).isEqualTo(1);
    }

    // --- sort=popular ---------------------------------------------------------------------------------

    @Test
    void sort_popular_orders_most_views_first_and_ties_by_later_published_first() throws Exception {
        Fixture most = publish(create("Most viewed"));
        Fixture earlier = publish(create("Same count, published first"));
        Fixture later = publish(create("Same count, published later"));
        Fixture unseen = publish(create("Nobody viewed"));
        // Larger than every counter already in the shared DB: these three posts are certain to come first, and no post
        // from
        // a test that ran earlier can slip in.
        long top = maxStoredViews() + 1000;
        setViews(most, top);
        setViews(earlier, top - 500);
        setViews(later, top - 500);

        JsonNode head = data(list("sort", "popular", "size", "3").andExpect(status().isOk()));
        assertThat(ids(head)).containsExactly(id(most), id(later), id(earlier));
        // The number in the DTO is exactly the number that was sorted by: the UI prints it next to the rank.
        assertThat(viewCounts(head)).containsExactly(top, top - 500, top - 500);

        // The whole list across every page: every published post, including posts with no row in post_views yet (left
        // join),
        // and the right ordering rule everywhere, not only at the top.
        assertThat(counterRows(unseen)).isZero();
        List<JsonNode> all = allPopular();
        assertThat(all).hasSize((int) publishedInDb());
        List<String> allIds =
                all.stream().map(node -> node.path("id").asString()).toList();
        assertThat(allIds).contains(id(unseen)).doesNotHaveDuplicates();
        for (int i = 1; i < all.size(); i++) {
            assertPopularOrder(all.get(i - 1), all.get(i));
        }
    }

    @Test
    void sort_accepts_only_latest_or_popular_and_popular_does_not_combine_with_filters() throws Exception {
        Fixture post = publish(create("Sort parameter check post"));

        assertError(list("sort", "bogus"), 400, "VALIDATION_ERROR", SORT_MESSAGE);
        assertError(list("sort", "popular", "tag", "x"), 400, "VALIDATION_ERROR", FILTER_MESSAGE);
        assertError(list("sort", "popular", "category", categorySlug), 400, "VALIDATION_ERROR", FILTER_MESSAGE);
        assertError(list("sort", "popular", "featured", "true"), 400, "VALIDATION_ERROR", FILTER_MESSAGE);

        // Control: the same filters with latest still filter as before...
        assertThat(ids(data(list("sort", "latest", "category", categorySlug).andExpect(status().isOk()))))
                .containsExactly(id(post));
        list("sort", "latest", "tag", "x").andExpect(status().isOk());
        list("sort", "latest", "featured", "true").andExpect(status().isOk());
        // ...and what never filtered anything (featured=false, an empty string) does not block popular either.
        list("sort", "popular", "featured", "false").andExpect(status().isOk());
        list("sort", "popular", "category", "", "tag", " ").andExpect(status().isOk());
        // latest is the default: no sort, an empty sort and sort=latest are the same list.
        List<String> latest = ids(data(list("sort", "latest", "size", "5").andExpect(status().isOk())));
        assertThat(ids(data(list("size", "5").andExpect(status().isOk())))).isEqualTo(latest);
        assertThat(ids(data(list("sort", "", "size", "5").andExpect(status().isOk()))))
                .isEqualTo(latest);
    }

    // --- Stats ----------------------------------------------------------------------------------------

    @Test
    void public_stats_count_only_what_readers_can_see() throws Exception {
        JsonNode before = stats();
        assertThat(before.size()).isEqualTo(4);
        for (String field : List.of("publishedPosts", "totalViews", "seriesCount", "galleryPhotos")) {
            assertThat(before.path(field).isIntegralNumber())
                    .as("%s is an integer", field)
                    .isTrue();
        }

        // A series with only unpublished parts does not exist for readers yet: not counted.
        UUID seriesId = createSeries("Statistics series " + suffix);
        Fixture part = create("First part of the series");
        setSeriesPosts(seriesId, part);
        assertStatsDelta(before, 0, 0, 0, 0);

        // The first part is published: one more post and one more series; its two views go into the total.
        publish(part);
        recordView(part.slug()).andExpect(status().isNoContent());
        recordView(part.slug()).andExpect(status().isNoContent());
        assertStatsDelta(before, 1, 2, 1, 0);

        // A hidden gallery image is not counted; a visible one is.
        uploadGalleryPhoto("an-" + suffix + ".png", false);
        assertStatsDelta(before, 1, 2, 1, 0);
        uploadGalleryPhoto("hien-" + suffix + ".png", true);
        assertStatsDelta(before, 1, 2, 1, 1);

        // Taking a post down: only the post, its views and a series that only it belonged to stop being counted, as
        // they disappear from every public page.
        unpublish(part);
        assertStatsDelta(before, 0, 0, 0, 1);
    }

    // --- Checks ---------------------------------------------------------------------------------------

    /** The ordering rule of sort=popular between two adjacent posts: views descending, then published later first, then id. */
    private static void assertPopularOrder(JsonNode first, JsonNode second) {
        String pair =
                first.path("slug").asString() + " before " + second.path("slug").asString();
        long firstViews = first.path("viewCount").asLong();
        long secondViews = second.path("viewCount").asLong();
        assertThat(firstViews).as("%s: viewCount", pair).isGreaterThanOrEqualTo(secondViews);
        if (firstViews == secondViews) {
            Instant firstPublished = Instant.parse(first.path("publishedAt").asString());
            Instant secondPublished = Instant.parse(second.path("publishedAt").asString());
            assertThat(firstPublished).as("%s: publishedAt", pair).isAfterOrEqualTo(secondPublished);
            if (firstPublished.equals(secondPublished)) {
                // Postgres compares uuid byte by byte, which is the text order of the lowercase hex form.
                assertThat(first.path("id").asString())
                        .as("%s: id", pair)
                        .isLessThan(second.path("id").asString());
            }
        }
    }

    private void assertStatsDelta(JsonNode before, long posts, long views, long series, long photos) throws Exception {
        JsonNode now = stats();
        assertThat(delta(before, now, "publishedPosts")).as("publishedPosts").isEqualTo(posts);
        assertThat(delta(before, now, "totalViews")).as("totalViews").isEqualTo(views);
        assertThat(delta(before, now, "seriesCount")).as("seriesCount").isEqualTo(series);
        assertThat(delta(before, now, "galleryPhotos")).as("galleryPhotos").isEqualTo(photos);
    }

    private static long delta(JsonNode before, JsonNode now, String field) {
        return now.path(field).asLong() - before.path(field).asLong();
    }

    private void assertError(ResultActions result, int status, String code) throws Exception {
        result.andExpect(status().is(status));
        JsonNode error = objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("error");
        assertThat(error.path("code").asString()).isEqualTo(code);
    }

    private void assertError(ResultActions result, int status, String code, String message) throws Exception {
        assertError(result, status, code);
        JsonNode error = objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("error");
        assertThat(error.path("message").asString()).isEqualTo(message);
    }

    // --- Reading --------------------------------------------------------------------------------------

    private ResultActions recordView(String slug) throws Exception {
        return mockMvc.perform(post("/api/v1/posts/" + slug + "/views"));
    }

    private long publicViewCount(Fixture post) throws Exception {
        return data(mockMvc.perform(get("/api/v1/posts/" + post.slug())).andExpect(status().isOk()))
                .path("viewCount")
                .asLong();
    }

    private JsonNode stats() throws Exception {
        return data(mockMvc.perform(get("/api/v1/stats")).andExpect(status().isOk()));
    }

    /** GET /api/v1/posts with pairs of parameter names and values. */
    private ResultActions list(String... params) throws Exception {
        MockHttpServletRequestBuilder request = get("/api/v1/posts");
        for (int i = 0; i < params.length; i += 2) {
            request.param(params[i], params[i + 1]);
        }
        return mockMvc.perform(request);
    }

    /** Every post by sort=popular across every page, in returned order; the total matches the API's own pagination. */
    private List<JsonNode> allPopular() throws Exception {
        List<JsonNode> all = new ArrayList<>();
        long totalElements = 0;
        int totalPages = 1;
        for (int page = 0; page < totalPages; page++) {
            JsonNode body = body(list("sort", "popular", "size", "100", "page", String.valueOf(page))
                    .andExpect(status().isOk()));
            body.path("data").forEach(all::add);
            totalPages = body.path("pagination").path("totalPages").asInt();
            totalElements = body.path("pagination").path("totalElements").asLong();
        }
        assertThat(all).hasSize((int) totalElements);
        return all;
    }

    private long storedViews(Fixture post) {
        return jdbcTemplate.queryForObject(
                "SELECT coalesce(sum(view_count), 0) FROM post_views WHERE post_id = ?", Long.class, post.id());
    }

    private long counterRows(Fixture post) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM post_views WHERE post_id = ?", Long.class, post.id());
    }

    private long maxStoredViews() {
        return jdbcTemplate.queryForObject("SELECT coalesce(max(view_count), 0) FROM post_views", Long.class);
    }

    private long publishedInDb() {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM posts WHERE status = 'PUBLISHED'", Long.class);
    }

    private static List<String> ids(JsonNode array) {
        List<String> ids = new ArrayList<>();
        array.forEach(node -> ids.add(node.path("id").asString()));
        return ids;
    }

    private static List<Long> viewCounts(JsonNode array) {
        List<Long> counts = new ArrayList<>();
        array.forEach(node -> counts.add(node.path("viewCount").asLong()));
        return counts;
    }

    private static String id(Fixture post) {
        return post.id().toString();
    }

    private JsonNode body(ResultActions result) throws Exception {
        return objectMapper.readTree(result.andReturn().getResponse().getContentAsString());
    }

    private JsonNode data(ResultActions result) throws Exception {
        return body(result).path("data");
    }

    // --- Ghi ------------------------------------------------------------------------------------------

    private Fixture create(String title) throws Exception {
        String payload = objectMapper.writeValueAsString(Map.of(
                "title", title + " " + suffix,
                "excerpt", "Summary " + suffix,
                "content", "Content about views" + suffix,
                "categoryId", categoryId.toString()));
        JsonNode created = data(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated()));
        return new Fixture(
                UUID.fromString(created.path("id").asString()),
                created.path("slug").asString());
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

    private void setViews(Fixture post, long views) {
        jdbcTemplate.update("""
                INSERT INTO post_views (post_id, view_count) VALUES (?, ?)
                ON CONFLICT (post_id) DO UPDATE SET view_count = excluded.view_count""", post.id(), views);
    }

    private UUID createSeries(String title) throws Exception {
        JsonNode created = data(mockMvc.perform(post("/api/v1/admin/series")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("title", title))))
                .andExpect(status().isCreated()));
        return UUID.fromString(created.path("id").asString());
    }

    private void setSeriesPosts(UUID seriesId, Fixture... posts) throws Exception {
        List<UUID> postIds = new ArrayList<>();
        for (Fixture post : posts) {
            postIds.add(post.id());
        }
        mockMvc.perform(put("/api/v1/admin/series/" + seriesId + "/posts")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("postIds", postIds))))
                .andExpect(status().isOk());
    }

    private void uploadGalleryPhoto(String originalName, boolean published) throws Exception {
        byte[] png;
        try (InputStream in = PostViewsIT.class.getResourceAsStream("/media/opaque.png")) {
            assertThat(in).as("fixture opaque.png").isNotNull();
            png = in.readAllBytes();
        }
        MockMultipartHttpServletRequestBuilder request =
                multipart("/api/v1/admin/gallery").file(new MockMultipartFile("file", originalName, "image/png", png));
        request.param("published", String.valueOf(published));
        mockMvc.perform(request.header("Authorization", admin)).andExpect(status().isCreated());
    }
}
