package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.fail;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.common.security.SeedAdmin;
import com.blog.media.entity.Media;
import com.blog.media.service.MediaService;
import com.blog.post.entity.Post;
import com.blog.post.repository.PostRepository;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import jakarta.persistence.EntityManagerFactory;
import java.io.IOException;
import java.io.InputStream;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Post read model: the cover image, the series with "Part n/m", the "Featured posts" rank and the view count must be
 * present on EVERY path that returns a post DTO: create, publish, admin detail and list, public detail, list and
 * search.
 *
 * Search is present in every case because it is a native query {@code select p.*}: a new column mapped wrongly on the entity (an
 * {@code @Formula}, for instance, which was measured to break every native query returning the entity) only shows up on that path.
 *
 * The four new columns on posts are written by dedicated endpoints, which have their own ITs (PostCoverIT, SeriesIT, FeaturedOrderIT).
 * Here the tests assign them with SQL to check only the read side, the way those endpoints write them: the entity only reads them.
 *
 * The DB is shared and never cleaned: each test has its own category (the public lists are filtered by it), its own
 * search word, names with a random suffix, counts nothing globally, and gives back every rank it assigned (ranks are
 * unique across the whole table). Fixture text avoids every word that PostSearchAndFeaturedIT checks.
 */
@AutoConfigureMockMvc
class PostReadModelIT extends AbstractIntegrationTest {

    private static final String ADMIN_DETAIL = "admin detail";
    private static final String ADMIN_LIST = "admin list";
    private static final String PUBLIC_DETAIL = "public detail";
    private static final String PUBLIC_LIST = "public list";
    private static final String SEARCH = "search";
    private static final String SERIES_DETAIL = "series detail";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private MediaService mediaService;

    @Autowired
    private PostRepository postRepository;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private EntityManagerFactory entityManagerFactory;

    private String admin;
    /** Random suffix for the names of this test's posts and series. */
    private String suffix;
    /** A word only this test's posts contain, so that search returns exactly them. */
    private String searchToken;

    private UUID categoryId;
    private String categorySlug;

    private record Fixture(UUID id, String slug) {}

    private record SeriesRow(UUID id, String slug, String title) {}

    /** The author as the DB stores it: id and email must never leave, the three middle fields are the public author. */
    private record Writer(
            UUID id, String email, String displayName, String login, String avatarUrl, String bearer, String slug) {}

    @BeforeEach
    void setUp() throws Exception {
        admin = auth.bearerForAdmin();
        String hex = UUID.randomUUID().toString().replace("-", "");
        suffix = hex.substring(0, 8);
        // ASCII letters only: the 'simple' parser keeps it as one word, without splitting digits or dashes.
        searchToken = "rm"
                + hex.chars()
                        .map(c -> 'a' + Character.digit(c, 16))
                        .collect(StringBuilder::new, StringBuilder::appendCodePoint, StringBuilder::append);
        JsonNode category = data(mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"name\":\"Category " + UUID.randomUUID() + "\"}"))
                .andExpect(status().isCreated()));
        categoryId = UUID.fromString(category.path("id").asString());
        categorySlug = category.path("slug").asString();
    }

    // --- Default values ------------------------------------------------------------------------

    @Test
    void new_post_has_no_cover_series_or_rank_and_0_views_on_every_read_path() throws Exception {
        JsonNode created = createBody("Default post");
        assertDefaults("create post", created);
        Fixture post = fixtureOf(created);
        assertDefaults("publish", publish(post));

        Map<String, JsonNode> everywhere = readEverywhere(post);

        assertThat(everywhere).containsOnlyKeys(ADMIN_DETAIL, ADMIN_LIST, PUBLIC_DETAIL, PUBLIC_LIST, SEARCH);
        everywhere.forEach(PostReadModelIT::assertDefaults);
    }

    // --- Series --------------------------------------------------------------------------------

    @Test
    void part_number_counts_published_parts_by_position_not_equal_to_position() throws Exception {
        Fixture part1 = create("Opening part");
        Fixture part2 = create("Middle part");
        Fixture part3 = create("Closing part");
        Fixture loose = create("Standalone post");
        SeriesRow series = insertSeries();
        putInSeries(part1, series, 1);
        putInSeries(part2, series, 2);
        putInSeries(part3, series, 3);
        publish(part1);
        publish(part3);
        publish(loose);
        // part2 is unpublished: a hole in the public reading order. The part stored at position 3 is the 2nd part a
        // reader
        // sees, and so is the position it shows: the stored 3 would tell a reader that a part is not published.

        readEverywhere(part1).forEach((where, post) -> assertSeries(where, post, series, 1, 1, 2));
        readEverywhere(part3).forEach((where, post) -> assertSeries(where, post, series, 2, 2, 2));
        // An unpublished part still carries its series (admin needs to know where it belongs, so it keeps the stored
        // position) but has no public part number.
        Map<String, JsonNode> draft = readEverywhere(part2);
        assertThat(draft).containsOnlyKeys(ADMIN_DETAIL, ADMIN_LIST);
        draft.forEach((where, post) -> assertSeries(where, post, series, 2, null, null));
        readEverywhere(loose).forEach((where, post) -> assertNullField(where, post, "series"));

        // The part number is computed at read time, not stored: the publish response itself already carries the new
        // number (the state just changed
        // in the same transaction), and the part stored at position 3 becomes 3/3 right away.
        assertSeries("publish the middle part", publish(part2), series, 2, 2, 3);
        readEverywhere(part3).forEach((where, post) -> assertSeries(where, post, series, 3, 3, 3));
    }

    // --- Views ---------------------------------------------------------------------------------

    @Test
    void views_come_from_post_views_and_post_without_a_row_has_0() throws Exception {
        Fixture viewed = create("Viewed post");
        Fixture unseen = create("Unviewed post");
        publish(viewed);
        publish(unseen);
        jdbcTemplate.update("INSERT INTO post_views (post_id, view_count) VALUES (?, ?)", viewed.id(), 7L);

        readEverywhere(viewed)
                .forEach((where, post) -> assertThat(post.path("viewCount").asLong())
                        .as("%s: viewCount", where)
                        .isEqualTo(7));
        readEverywhere(unseen)
                .forEach((where, post) -> assertThat(post.path("viewCount").asLong())
                        .as("%s: viewCount", where)
                        .isZero());
    }

    // --- Cover image ---------------------------------------------------------------------------

    @Test
    void cover_image_accompanies_post_on_every_read_path() throws Exception {
        Fixture withCover = create("Post with a cover image");
        Fixture without = create("Post without a cover image");
        String altText = "Test cover image " + suffix;
        Media cover = storeMedia(altText);
        attachCover(withCover, cover);
        publish(withCover);
        publish(without);

        readEverywhere(withCover).forEach((where, post) -> {
            JsonNode node = post.path("cover");
            assertThat(node.path("id").asString())
                    .as("%s: cover.id", where)
                    .isEqualTo(cover.getId().toString());
            assertThat(node.path("fileName").asString())
                    .as("%s: cover.fileName", where)
                    .isEqualTo(cover.getId() + ".png");
            assertThat(node.path("width").asInt()).as("%s: cover.width", where).isEqualTo(cover.getWidth());
            assertThat(node.path("height").asInt())
                    .as("%s: cover.height", where)
                    .isEqualTo(cover.getHeight());
            assertThat(node.path("altText").asString())
                    .as("%s: cover.altText", where)
                    .isEqualTo(altText);
            assertThat(node.path("dominantColor").asString())
                    .as("%s: cover.dominantColor", where)
                    .matches("^#[0-9a-f]{6}$");
            // The post DTO is public: the file name on the uploader's machine never travels with it.
            assertThat(node.has("originalFilename"))
                    .as("%s: cover.originalFilename", where)
                    .isFalse();
        });
        readEverywhere(without).forEach((where, post) -> assertNullField(where, post, "cover"));
    }

    // --- "Featured posts" rank ------------------------------------------------------------------

    @Test
    void featured_rank_accompanies_post_on_every_read_path() throws Exception {
        Fixture ranked = create("Ranked post");
        Fixture unranked = create("Picked post without a rank");
        publish(ranked);
        publish(unranked);
        jdbcTemplate.update("UPDATE posts SET featured = true WHERE id IN (?, ?)", ranked.id(), unranked.id());
        int rank = assignFreeRank(ranked);
        try {
            readEverywhere(ranked)
                    .forEach((where, post) -> assertThat(
                                    post.path("featuredRank").asInt())
                            .as("%s: featuredRank", where)
                            .isEqualTo(rank));
            // Selected but not yet ranked (a post just featured): featured but rank null.
            readEverywhere(unranked).forEach((where, post) -> {
                assertThat(post.path("featured").asBoolean())
                        .as("%s: featured", where)
                        .isTrue();
                assertNullField(where, post, "featuredRank");
            });
        } finally {
            clearRank(ranked);
        }
    }

    // --- Modified date --------------------------------------------------------------------------

    @Test
    void updatedAt_on_every_read_path_equals_admin_detail_and_is_unchanged_by_selecting_or_arranging_series()
            throws Exception {
        Fixture post = create("Post with an edit date");
        publish(post);
        Instant before = updatedAtEverywhere(post);

        // Select, unselect, add to a series and remove again, through exactly those endpoints: editorial work, not a
        // post edit.
        // FeaturedOrderIT and SeriesIT check that on the admin detail; here it is the lists, the source of the sitemap
        // lastmod.
        mockMvc.perform(post("/api/v1/admin/posts/" + post.id() + "/feature").header("Authorization", admin))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/admin/posts/" + post.id() + "/unfeature").header("Authorization", admin))
                .andExpect(status().isOk());
        UUID series = UUID.fromString(data(mockMvc.perform(post("/api/v1/admin/series")
                                .header("Authorization", admin)
                                .contentType(APPLICATION_JSON)
                                .content(
                                        objectMapper.writeValueAsString(Map.of("title", "Edit date series " + suffix))))
                        .andExpect(status().isCreated()))
                .path("id")
                .asString());
        setSeriesPosts(series, List.of(post.id()));
        setSeriesPosts(series, List.of());
        mockMvc.perform(delete("/api/v1/admin/series/" + series).header("Authorization", admin))
                .andExpect(status().isNoContent());

        assertThat(updatedAtEverywhere(post)).isEqualTo(before);

        // Control: a real post edit changes updatedAt, and every read path changes with it, so the comparison above is
        // not on a
        // field that never changes.
        JsonNode detail =
                data(mockMvc.perform(get("/api/v1/admin/posts/" + post.id()).header("Authorization", admin))
                        .andExpect(status().isOk()));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", detail.path("title").asString() + " (edited)");
        body.put("excerpt", detail.path("excerpt").asString());
        body.put("content", detail.path("content").asString());
        body.put("categoryId", categoryId.toString());
        body.put("tagIds", List.of());
        body.put("slug", detail.path("slug").asString());
        mockMvc.perform(put("/api/v1/admin/posts/" + post.id())
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isOk());
        assertThat(updatedAtEverywhere(post)).isAfter(before);
    }

    /**
     * A write's response must carry exactly the {@code updatedAt} the DB just stored, digit for digit, not a value that only
     * ever existed in memory: the editor (autosave) compares this mark with the post it reads back later. Two ways of drifting were measured: the
     * Hibernate auto-flush probe before the views read calls {@code @PreUpdate} without writing anything, then the flush at commit
     * calls it again and writes a different time a few ms later; and the in-memory value is finer than the microseconds Postgres stores.
     */
    @Test
    void response_of_create_update_publish_unpublish_and_restore_carries_the_stored_updatedAt() throws Exception {
        JsonNode created = createBody("Post with an exact edit date");
        Fixture post = fixtureOf(created);
        assertThat(created.path("updatedAt").asString()).as("create").isEqualTo(storedUpdatedAt(post));

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", "Post with an exact edit date (edited) " + suffix);
        body.put("excerpt", created.path("excerpt").asString());
        body.put("content", created.path("content").asString() + " one more sentence");
        body.put("categoryId", categoryId.toString());
        body.put("tagIds", List.of());
        body.put("slug", post.slug());
        JsonNode saved = data(mockMvc.perform(put("/api/v1/admin/posts/" + post.id())
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andExpect(status().isOk()));
        assertThat(saved.path("updatedAt").asString())
                .as("edit")
                .isEqualTo(storedUpdatedAt(post))
                .isNotEqualTo(created.path("updatedAt").asString());

        assertThat(publish(post).path("updatedAt").asString()).as("publish").isEqualTo(storedUpdatedAt(post));
        JsonNode unpublished = data(mockMvc.perform(
                        post("/api/v1/admin/posts/" + post.id() + "/unpublish").header("Authorization", admin))
                .andExpect(status().isOk()));
        assertThat(unpublished.path("updatedAt").asString()).as("withdraw").isEqualTo(storedUpdatedAt(post));

        // The edit above changed text, so it recorded a revision: restoring it is also a post write.
        String revision = data(mockMvc.perform(get("/api/v1/admin/posts/" + post.id() + "/revisions")
                                .header("Authorization", admin))
                        .andExpect(status().isOk()))
                .get(0)
                .path("id")
                .asString();
        JsonNode restored =
                data(mockMvc.perform(post("/api/v1/admin/posts/" + post.id() + "/revisions/" + revision + "/restore")
                                .header("Authorization", admin))
                        .andExpect(status().isOk()));
        assertThat(restored.path("updatedAt").asString()).as("restore").isEqualTo(storedUpdatedAt(post));
    }

    // --- Public author ---------------------------------------------------------------------------

    @Test
    void public_author_accompanies_post_on_every_read_path_without_id_email_or_role() throws Exception {
        Writer writer = writer("cong-khai");
        Fixture byWriter = fixtureOf(createBody(writer.bearer(), "Author post"));
        publish(writer.bearer(), byWriter);
        Fixture byOwner = create("Site owner post");
        publish(byOwner);
        SeriesRow series = insertSeries();
        putInSeries(byWriter, series, 1);
        putInSeries(byOwner, series, 2);
        // The seed row is shared by every test class and may already be linked to GitHub: the expected value is read
        // from the DB.
        Map<String, Object> seed = jdbcTemplate.queryForMap(
                "SELECT email, display_name, github_login, avatar_url, " + "public_slug FROM users WHERE id = ?",
                SeedAdmin.ID);
        Writer owner = new Writer(
                SeedAdmin.ID,
                (String) seed.get("email"),
                (String) seed.get("display_name"),
                (String) seed.get("github_login"),
                (String) seed.get("avatar_url"),
                admin,
                (String) seed.get("public_slug"));

        assertAuthorEverywhere(byWriter, series, writer, false);
        assertAuthorEverywhere(byOwner, series, owner, true);
    }

    @Test
    void authors_are_batch_loaded_so_sql_count_of_list_search_and_series_is_the_same_for_1_or_5_authors()
            throws Exception {
        SeriesRow series = insertSeries();
        Map<String, Long> forOne = null;
        for (int i = 1; i <= 5; i++) {
            Writer writer = writer("lo-" + i);
            Fixture part = fixtureOf(createBody(writer.bearer(), "Author part " + i));
            publish(writer.bearer(), part);
            putInSeries(part, series, i);
            if (i == 1) {
                forOne = statementsOfReads(series, 1);
            }
        }

        // Five posts by five different authors: authors (like category, tags, series) are loaded in batches, one
        // statement for the whole
        // page, not one per post.
        assertThat(statementsOfReads(series, 5)).isEqualTo(forOne);
    }

    // --- Entity save paths do not touch read-only columns -------------------------------------------

    @Test
    void full_put_publish_and_unpublish_do_not_touch_cover_series_rank_views() throws Exception {
        Fixture post = create("Post to be edited");
        publish(post);
        Media cover = storeMedia("Cover image " + suffix);
        attachCover(post, cover);
        SeriesRow series = insertSeries();
        putInSeries(post, series, 4);
        jdbcTemplate.update("INSERT INTO post_views (post_id, view_count) VALUES (?, ?)", post.id(), 5L);
        jdbcTemplate.update("UPDATE posts SET featured = true WHERE id = ?", post.id());
        int rank = assignFreeRank(post);
        try {
            JsonNode before =
                    data(mockMvc.perform(get("/api/v1/admin/posts/" + post.id()).header("Authorization", admin))
                            .andExpect(status().isOk()));
            // A full PUT body as the editor sends it: replaces everything it knows, and has no key for the four new
            // fields. A post PUT is still a full replacement as before; it just never touches those columns.
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("title", before.path("title").asString() + " (edited)");
            body.put("excerpt", before.path("excerpt").asString());
            body.put("content", before.path("content").asString());
            body.put("categoryId", before.path("category").path("id").asString());
            body.put("tagIds", List.of());
            body.put("slug", before.path("slug").asString());

            JsonNode updated = data(mockMvc.perform(put("/api/v1/admin/posts/" + post.id())
                            .header("Authorization", admin)
                            .contentType(APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(body)))
                    .andExpect(status().isOk()));

            // Control: the PUT took effect...
            assertThat(updated.path("title").asString()).endsWith("(edited)");
            // ...but touches nothing beyond what it replaces. Stored position 4 yet part 1/1 (and position 1 in the
            // answer): the only published part.
            assertUntouched("PUT", updated, cover, series, rank, 1, 1);
            readEverywhere(post).forEach((where, node) -> assertUntouched(where, node, cover, series, rank, 1, 1));

            // The two remaining entity save paths are the same; the part number changes with the publish status.
            JsonNode unpublished = data(mockMvc.perform(post("/api/v1/admin/posts/" + post.id() + "/unpublish")
                            .header("Authorization", admin))
                    .andExpect(status().isOk()));
            assertUntouched("unpublish", unpublished, cover, series, rank, null, null);
            assertUntouched("republish", publish(post), cover, series, rank, 1, 1);

            // And at the DB level, not only in the response.
            Map<String, Object> row = jdbcTemplate.queryForMap(
                    "SELECT cover_media_id, series_id, series_position, featured_rank FROM posts WHERE id = ?",
                    post.id());
            assertThat(row)
                    .containsEntry("cover_media_id", cover.getId())
                    .containsEntry("series_id", series.id())
                    .containsEntry("series_position", 4)
                    .containsEntry("featured_rank", rank);
            assertThat(jdbcTemplate.queryForObject(
                            "SELECT view_count FROM post_views WHERE post_id = ?", Long.class, post.id()))
                    .isEqualTo(5L);
        } finally {
            clearRank(post);
        }
    }

    @Test
    void saving_post_entity_does_not_overwrite_read_only_columns_changed_by_sql_after_loading() throws Exception {
        Fixture post = create("Post loaded before assignment");
        Media cover = storeMedia("Image " + suffix);
        SeriesRow series = insertSeries();
        jdbcTemplate.update("UPDATE posts SET featured = true WHERE id = ?", post.id());
        int rank = nextFreeRank();
        try {
            // Simulates two overlapping requests: the entity is loaded while the four columns are still null, then a
            // separate SQL statement (attaching
            // a cover, placing in a series, ranking) runs before the entity is saved. The entity has no @DynamicUpdate,
            // so
            // every save writes back every column it may write: if these four columns were among them, the old null
            // would overwrite the new value.
            new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                Post entity = postRepository.findById(post.id()).orElseThrow();
                jdbcTemplate.update("""
                        UPDATE posts SET cover_media_id = ?, series_id = ?, series_position = 1, featured_rank = ?
                        WHERE id = ?""", cover.getId(), series.id(), rank, post.id());
                entity.setTitle(entity.getTitle() + " (edited)");
                postRepository.saveAndFlush(entity);
            });

            Map<String, Object> row = jdbcTemplate.queryForMap(
                    "SELECT title, cover_media_id, series_id, series_position, featured_rank FROM posts WHERE id = ?",
                    post.id());
            // Control: the entity save really did write...
            assertThat((String) row.get("title")).endsWith("(edited)");
            // ...without carrying along the old values of the columns it only reads.
            assertThat(row)
                    .containsEntry("cover_media_id", cover.getId())
                    .containsEntry("series_id", series.id())
                    .containsEntry("series_position", 1)
                    .containsEntry("featured_rank", rank);
        } finally {
            clearRank(post);
        }
    }

    // --- Constraints from migrations V12-V16: the read model data is always consistent ----------

    @Test
    void series_and_position_go_in_pairs_one_post_per_position_and_series_with_posts_cannot_be_deleted()
            throws Exception {
        Fixture first = create("First constraint");
        Fixture second = create("Second constraint");
        SeriesRow series = insertSeries();

        // Control: a valid pair goes through.
        putInSeries(first, series, 1);
        // A series with no position, a position with no series, position < 1: no half-formed data.
        assertRejected("UPDATE posts SET series_id = ?, series_position = NULL WHERE id = ?", series.id(), second.id());
        assertRejected("UPDATE posts SET series_id = NULL, series_position = 1 WHERE id = ?", first.id());
        assertRejected("UPDATE posts SET series_id = ?, series_position = 0 WHERE id = ?", series.id(), second.id());
        // Two posts at the same position, checked right at the statement; a different position is fine.
        assertRejected("UPDATE posts SET series_id = ?, series_position = 1 WHERE id = ?", series.id(), second.id());
        putInSeries(second, series, 2);
        // Deleting a series that still has posts: the foreign key has no ON DELETE, so it blocks (the service must
        // detach the posts first).
        assertRejected("DELETE FROM series WHERE id = ?", series.id());
        // Series names that differ only by case collide.
        assertRejected(
                "INSERT INTO series (title, slug) VALUES (?, ?)",
                series.title().toUpperCase(Locale.ROOT),
                "series-khac-" + suffix);
    }

    @Test
    void rank_exists_only_on_featured_posts_from_1_and_no_two_posts_share_a_rank() throws Exception {
        Fixture plain = create("Post not picked");
        Fixture featured = create("Picked post with a rank");
        Fixture another = create("Another picked post");
        jdbcTemplate.update("UPDATE posts SET featured = true WHERE id IN (?, ?)", featured.id(), another.id());
        // Control: a featured post can get a rank.
        int rank = assignFreeRank(featured);
        try {
            assertRejected("UPDATE posts SET featured_rank = ? WHERE id = ?", rank + 1, plain.id());
            assertRejected("UPDATE posts SET featured_rank = 0 WHERE id = ?", another.id());
            assertRejected("UPDATE posts SET featured_rank = ? WHERE id = ?", rank, another.id());
            // Unfeatured while keeping its rank: the unfeature path must clear the rank in the same statement.
            assertRejected("UPDATE posts SET featured = false WHERE id = ?", featured.id());
        } finally {
            clearRank(featured);
        }
    }

    @Test
    void cover_image_belongs_to_exactly_one_post_and_deleting_the_image_only_detaches_the_cover() throws Exception {
        Fixture owner = create("Post keeping its cover image");
        Fixture other = create("Post wanting to share");
        Media cover = storeMedia(null);

        // Control: attaching to one post works, to a second post does not.
        attachCover(owner, cover);
        assertRejected("UPDATE posts SET cover_media_id = ? WHERE id = ?", cover.getId(), other.id());

        mediaService.delete(cover.getId());

        // SET NULL: the post stays intact, it just has no cover any more.
        assertThat(jdbcTemplate.queryForObject("SELECT cover_media_id FROM posts WHERE id = ?", UUID.class, owner.id()))
                .isNull();
        assertNullField(ADMIN_DETAIL, readEverywhere(owner).get(ADMIN_DETAIL), "cover");
    }

    @Test
    void views_are_non_negative_and_go_with_the_post_when_it_is_deleted() throws Exception {
        Fixture post = create("Viewed post to be deleted");
        // Control: a valid counter.
        jdbcTemplate.update("INSERT INTO post_views (post_id, view_count) VALUES (?, ?)", post.id(), 3L);
        assertRejected("UPDATE post_views SET view_count = -1 WHERE post_id = ?", post.id());

        // ON DELETE CASCADE: deleting a post that has views is still a 204, not a 409 because a row still points to it.
        mockMvc.perform(delete("/api/v1/admin/posts/" + post.id()).header("Authorization", admin))
                .andExpect(status().isNoContent());
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM post_views WHERE post_id = ?", Long.class, post.id()))
                .isZero();
    }

    // --- Reading on every path -----------------------------------------------------------------

    /**
     * The post as each read path returns it, by path name. A published post has three more public paths. The post must be present in
     * every list it belongs to: missing is an error, not skipped.
     */
    private Map<String, JsonNode> readEverywhere(Fixture post) throws Exception {
        Map<String, JsonNode> views = new LinkedHashMap<>();
        JsonNode detail =
                data(mockMvc.perform(get("/api/v1/admin/posts/" + post.id()).header("Authorization", admin))
                        .andExpect(status().isOk()));
        views.put(ADMIN_DETAIL, detail);
        // Sorted by creation date descending: the post just created in this test is always among the first 100.
        views.put(
                ADMIN_LIST,
                find(
                        post,
                        mockMvc.perform(
                                get("/api/v1/admin/posts").param("size", "100").header("Authorization", admin))));
        if ("PUBLISHED".equals(detail.path("status").asString())) {
            views.put(
                    PUBLIC_DETAIL,
                    data(mockMvc.perform(get("/api/v1/posts/" + post.slug())).andExpect(status().isOk())));
            views.put(
                    PUBLIC_LIST,
                    find(
                            post,
                            mockMvc.perform(get("/api/v1/posts")
                                    .param("category", categorySlug)
                                    .param("size", "100"))));
            views.put(
                    SEARCH,
                    find(
                            post,
                            mockMvc.perform(get("/api/v1/posts/search")
                                    .param("q", searchToken)
                                    .param("size", "100"))));
        }
        return views;
    }

    /**
     * The post's {@code updatedAt} on every read path, each an ISO-8601 string equal to the admin detail's value
     * (re-read from the DB, not an in-memory value from a write). Returns that value.
     */
    private Instant updatedAtEverywhere(Fixture post) throws Exception {
        Map<String, JsonNode> views = readEverywhere(post);
        assertThat(views).containsOnlyKeys(ADMIN_DETAIL, ADMIN_LIST, PUBLIC_DETAIL, PUBLIC_LIST, SEARCH);
        Instant expected =
                Instant.parse(views.get(ADMIN_DETAIL).path("updatedAt").asString());
        views.forEach((where, node) -> {
            assertThat(node.path("updatedAt").isString())
                    .as("%s: updatedAt is a string", where)
                    .isTrue();
            assertThat(Instant.parse(node.path("updatedAt").asString()))
                    .as("%s: updatedAt", where)
                    .isEqualTo(expected);
        });
        return expected;
    }

    /** {@code updatedAt} re-read from the DB through the admin detail, exactly the string the API returns. */
    private String storedUpdatedAt(Fixture post) throws Exception {
        return data(mockMvc.perform(get("/api/v1/admin/posts/" + post.id()).header("Authorization", admin))
                        .andExpect(status().isOk()))
                .path("updatedAt")
                .asString();
    }

    private void setSeriesPosts(UUID series, List<UUID> postIds) throws Exception {
        mockMvc.perform(put("/api/v1/admin/series/" + series + "/posts")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("postIds", postIds))))
                .andExpect(status().isOk());
    }

    private JsonNode find(Fixture post, ResultActions list) throws Exception {
        return find(post, data(list.andExpect(status().isOk())));
    }

    private static JsonNode find(Fixture post, JsonNode items) {
        for (JsonNode node : items) {
            if (post.id().toString().equals(node.path("id").asString())) {
                return node;
            }
        }
        return fail("Post not found: %s in the list", post.slug());
    }

    /** The post as the public series detail page returns it (the published parts, each a post summary). */
    private JsonNode seriesPart(SeriesRow series, Fixture post) throws Exception {
        return find(
                post,
                data(mockMvc.perform(get("/api/v1/series/" + series.slug())).andExpect(status().isOk()))
                        .path("posts"));
    }

    /**
     * The number of SQL statements of the three read paths that return many posts; each path must return exactly {@code expected} posts, all of this test's
     * (same category, same search word, same series).
     */
    private Map<String, Long> statementsOfReads(SeriesRow series, int expected) throws Exception {
        Map<String, Long> statements = new LinkedHashMap<>();
        statements.put(
                PUBLIC_LIST,
                statementsFor(() -> assertThat(data(mockMvc.perform(get("/api/v1/posts")
                                                .param("category", categorySlug)
                                                .param("size", "100"))
                                        .andExpect(status().isOk()))
                                .size())
                        .as(PUBLIC_LIST)
                        .isEqualTo(expected)));
        statements.put(
                SEARCH,
                statementsFor(() -> assertThat(data(mockMvc.perform(get("/api/v1/posts/search")
                                                .param("q", searchToken)
                                                .param("size", "100"))
                                        .andExpect(status().isOk()))
                                .size())
                        .as(SEARCH)
                        .isEqualTo(expected)));
        statements.put(
                SERIES_DETAIL,
                statementsFor(() -> assertThat(data(mockMvc.perform(get("/api/v1/series/" + series.slug()))
                                        .andExpect(status().isOk()))
                                .path("posts")
                                .size())
                        .as(SERIES_DETAIL)
                        .isEqualTo(expected)));
        return statements;
    }

    private interface Request {
        void run() throws Exception;
    }

    /**
     * The number of SQL statements Hibernate prepares while running one request, as in CommentIT: statistics are off by default and shared across the
     * SessionFactory, so they are enabled only around that request and then restored.
     */
    private long statementsFor(Request request) throws Exception {
        Statistics statistics =
                entityManagerFactory.unwrap(SessionFactory.class).getStatistics();
        boolean wasEnabled = statistics.isStatisticsEnabled();
        statistics.setStatisticsEnabled(true);
        try {
            statistics.clear();
            request.run();
            return statistics.getPrepareStatementCount();
        } finally {
            statistics.setStatisticsEnabled(wasEnabled);
        }
    }

    // --- Checks --------------------------------------------------------------------------------

    private static void assertDefaults(String where, JsonNode post) {
        assertNullField(where, post, "cover");
        assertNullField(where, post, "series");
        assertNullField(where, post, "featuredRank");
        assertThat(post.path("viewCount").isIntegralNumber())
                .as("%s: viewCount is an integer", where)
                .isTrue();
        assertThat(post.path("viewCount").asLong()).as("%s: viewCount", where).isZero();
    }

    /** The key is present with a JSON null value: "no value" is a value, not a missing field. */
    private static void assertNullField(String where, JsonNode post, String field) {
        assertThat(post.has(field)).as("%s: must have key %s", where, field).isTrue();
        assertThat(post.get(field).isNull())
                .as("%s: %s must be null", where, field)
                .isTrue();
    }

    private static void assertSeries(
            String where, JsonNode post, SeriesRow series, int position, Integer partNumber, Integer partCount) {
        JsonNode ref = post.path("series");
        assertThat(ref.path("id").asString())
                .as("%s: series.id", where)
                .isEqualTo(series.id().toString());
        assertThat(ref.path("slug").asString()).as("%s: series.slug", where).isEqualTo(series.slug());
        assertThat(ref.path("title").asString()).as("%s: series.title", where).isEqualTo(series.title());
        assertThat(ref.path("position").asInt())
                .as("%s: series.position", where)
                .isEqualTo(position);
        assertNullableInt(where + ": series.partNumber", ref, "partNumber", partNumber);
        assertNullableInt(where + ": series.partCount", ref, "partCount", partCount);
    }

    /**
     * The post of the PUT test: cover, series at stored position 4, rank and 5 views intact. The position in the answer is the
     * stored 4 while the post is not published and its part number when it is (the stored one is checked in the database).
     */
    private static void assertUntouched(
            String where,
            JsonNode post,
            Media cover,
            SeriesRow series,
            int rank,
            Integer partNumber,
            Integer partCount) {
        assertThat(post.path("cover").path("id").asString())
                .as("%s: cover.id", where)
                .isEqualTo(cover.getId().toString());
        assertSeries(where, post, series, partNumber != null ? partNumber : 4, partNumber, partCount);
        assertThat(post.path("featuredRank").asInt())
                .as("%s: featuredRank", where)
                .isEqualTo(rank);
        assertThat(post.path("viewCount").asLong()).as("%s: viewCount", where).isEqualTo(5);
    }

    private void assertRejected(String sql, Object... args) {
        assertThatThrownBy(() -> jdbcTemplate.update(sql, args))
                .as("must be rejected: %s", sql)
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    /** The post's author on every read path of it, including the series detail page. */
    private void assertAuthorEverywhere(Fixture post, SeriesRow series, Writer writer, boolean siteOwner)
            throws Exception {
        Map<String, JsonNode> views = readEverywhere(post);
        views.put(SERIES_DETAIL, seriesPart(series, post));
        assertThat(views).containsOnlyKeys(ADMIN_DETAIL, ADMIN_LIST, PUBLIC_DETAIL, PUBLIC_LIST, SEARCH, SERIES_DETAIL);
        views.forEach((where, node) -> assertAuthor(where, node, writer, siteOwner));
    }

    /** Exactly five keys, exactly the values; the author's id and email appear nowhere in the whole post, and there is no role key. */
    private void assertAuthor(String where, JsonNode post, Writer writer, boolean siteOwner) {
        JsonNode author = post.path("author");
        assertThat(author.propertyNames())
                .as("%s: author keys", where)
                .containsExactlyInAnyOrder("displayName", "githubLogin", "avatarUrl", "siteOwner", "profileSlug");
        assertThat(author.path("profileSlug").asString())
                .as("%s: author.profileSlug", where)
                .isEqualTo(writer.slug());
        assertThat(author.path("displayName").asString())
                .as("%s: author.displayName", where)
                .isEqualTo(writer.displayName());
        assertNullableText(where + ": author.githubLogin", author, "githubLogin", writer.login());
        assertNullableText(where + ": author.avatarUrl", author, "avatarUrl", writer.avatarUrl());
        assertThat(author.path("siteOwner").isBoolean())
                .as("%s: author.siteOwner is a boolean", where)
                .isTrue();
        assertThat(author.path("siteOwner").asBoolean())
                .as("%s: author.siteOwner", where)
                .isEqualTo(siteOwner);
        assertThat(objectMapper.writeValueAsString(post))
                .as("%s: whole post", where)
                .doesNotContain(writer.id().toString())
                .doesNotContain(writer.email())
                .doesNotContain("\"role\"");
    }

    private static void assertNullableText(String what, JsonNode node, String field, String expected) {
        assertThat(node.has(field)).as("%s: must have keys", what).isTrue();
        if (expected == null) {
            assertThat(node.get(field).isNull()).as("%s must be null", what).isTrue();
        } else {
            assertThat(node.get(field).asString()).as(what).isEqualTo(expected);
        }
    }

    private static void assertNullableInt(String what, JsonNode node, String field, Integer expected) {
        assertThat(node.has(field)).as("%s: must have keys", what).isTrue();
        if (expected == null) {
            assertThat(node.get(field).isNull()).as("%s must be null", what).isTrue();
        } else {
            assertThat(node.get(field).isIntegralNumber())
                    .as("%s is an integer", what)
                    .isTrue();
            assertThat(node.get(field).asInt()).as(what).isEqualTo(expected);
        }
    }

    // --- Fixture -------------------------------------------------------------------------------

    private JsonNode createBody(String title) throws Exception {
        return createBody(admin, title);
    }

    /** The post of the token's owner (ADMIN or AUTHOR), in this test's category and with this test's search word. */
    private JsonNode createBody(String bearer, String title) throws Exception {
        String payload = objectMapper.writeValueAsString(Map.of(
                "title", title + " " + suffix,
                "excerpt", "Summary " + suffix,
                "content", "Read model test content " + searchToken,
                "categoryId", categoryId.toString()));
        return data(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", bearer)
                        .contentType(APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated()));
    }

    /**
     * An AUTHOR with an email (a password account) who has linked GitHub, written with SQL like a real link; the display name
     * does not contain the email (the fixture's default name does).
     */
    private Writer writer(String stem) {
        String email = "tac-gia-" + stem + "-" + suffix + "@blog.local";
        User user = auth.createAuthor(email);
        long githubId = auth.nextGithubId();
        Writer writer = new Writer(
                user.getId(),
                email,
                "Author " + stem + " " + suffix,
                "tac-gia-" + stem + "-" + suffix,
                "https://avatars.githubusercontent.com/u/" + githubId + "?v=4",
                auth.bearerFor(user),
                user.getPublicSlug());
        assertThat(jdbcTemplate.update(
                        "UPDATE users SET display_name = ?, github_id = ?, github_login = ?, avatar_url = ? WHERE id = ?",
                        writer.displayName(),
                        githubId,
                        writer.login(),
                        writer.avatarUrl(),
                        writer.id()))
                .isEqualTo(1);
        return writer;
    }

    private Fixture create(String title) throws Exception {
        return fixtureOf(createBody(title));
    }

    private static Fixture fixtureOf(JsonNode post) {
        return new Fixture(
                UUID.fromString(post.path("id").asString()), post.path("slug").asString());
    }

    private JsonNode publish(Fixture post) throws Exception {
        return publish(admin, post);
    }

    private JsonNode publish(String bearer, Fixture post) throws Exception {
        return data(mockMvc.perform(
                        post("/api/v1/admin/posts/" + post.id() + "/publish").header("Authorization", bearer))
                .andExpect(status().isOk()));
    }

    private SeriesRow insertSeries() {
        String title = "Trial series " + suffix;
        String slug = "series-thu-" + suffix;
        UUID id = jdbcTemplate.queryForObject(
                "INSERT INTO series (title, slug, description) VALUES (?, ?, ?) RETURNING id",
                UUID.class,
                title,
                slug,
                "Series description " + suffix);
        return new SeriesRow(id, slug, title);
    }

    private void putInSeries(Fixture post, SeriesRow series, int position) {
        assertThat(jdbcTemplate.update(
                        "UPDATE posts SET series_id = ?, series_position = ? WHERE id = ?",
                        series.id(),
                        position,
                        post.id()))
                .isEqualTo(1);
    }

    private Media storeMedia(String altText) throws IOException {
        byte[] png;
        try (InputStream in = PostReadModelIT.class.getResourceAsStream("/media/opaque.png")) {
            assertThat(in).as("fixture opaque.png").isNotNull();
            png = in.readAllBytes();
        }
        return mediaService.persist(
                mediaService.prepare(new MockMultipartFile("file", "opaque.png", "image/png", png)), altText, null);
    }

    private void attachCover(Fixture post, Media cover) {
        assertThat(jdbcTemplate.update("UPDATE posts SET cover_media_id = ? WHERE id = ?", cover.getId(), post.id()))
                .isEqualTo(1);
    }

    /** The rank is unique across the whole table; a number larger than any existing rank leaves other tests' posts alone. */
    private int nextFreeRank() {
        Integer rank =
                jdbcTemplate.queryForObject("SELECT coalesce(max(featured_rank), 0) + 1 FROM posts", Integer.class);
        assertThat(rank).isNotNull();
        return rank;
    }

    private int assignFreeRank(Fixture post) {
        int rank = nextFreeRank();
        assertThat(jdbcTemplate.update("UPDATE posts SET featured_rank = ? WHERE id = ?", rank, post.id()))
                .isEqualTo(1);
        return rank;
    }

    /** Gives the ranks back: a ranked post comes first in the "Featured posts" list of every test that runs later. */
    private void clearRank(Fixture post) {
        jdbcTemplate.update("UPDATE posts SET featured_rank = NULL WHERE id = ?", post.id());
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("data");
    }
}
