package com.blog.tag;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
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
 * Edit, delete and merge tags: {@code PUT}/{@code DELETE /api/v1/admin/tags/{id}} and {@code POST
 * /api/v1/admin/tags/{id}/merge}, ADMIN only.
 *
 * The slug is the public URL {@code /tags/{slug}}, so renaming never changes it. Deleting a tag attached to
 * posts makes the tag leave those posts (ON DELETE CASCADE of post_tags), while the posts stay intact.
 * Merging gives every post carrying the source tag the target tag (exactly once) and then deletes the source
 * tag, also without touching the {@code updated_at} of any post.
 *
 * Every request goes through the real filter chain with a real token, as in CategoryAdminIT.
 *
 * The shared DB is never cleaned: every name has a random suffix; the tag list is only checked for presence
 * or absence, never for length. Post text avoids every word that PostSearchAndFeaturedIT searches for.
 */
@AutoConfigureMockMvc
class TagAdminIT extends AbstractIntegrationTest {

    private static final String ADMIN_TAGS = "/api/v1/admin/tags";
    private static final String PUBLIC_TAGS = "/api/v1/tags";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PlatformTransactionManager transactionManager;

    private String admin;
    private String suffix;
    /** A category owned by the test: a post needs a category to be published. */
    private UUID categoryId;

    @BeforeEach
    void setUp() throws Exception {
        admin = auth.bearerForAdmin();
        suffix = UUID.randomUUID().toString().substring(0, 8);
        categoryId = idOf(data(mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(json(Map.of("name", "Category tags " + suffix))))
                .andExpect(status().isCreated())));
    }

    // --- Edit --------------------------------------------------------------------------------------

    @Test
    void rename_tag_returns_200_slug_unchanged_and_public_side_shows_new_name_under_old_slug() throws Exception {
        JsonNode created = data(createTag("Old Tag " + suffix).andExpect(status().isCreated()));
        UUID id = idOf(created);
        String slug = created.path("slug").asString();
        assertThat(slug).isEqualTo("old-tag-" + suffix);
        UUID post = createPost("Post with the renamed tag", List.of(id));
        publish(post);

        JsonNode updated = data(updateTag(id, "  New Tag " + suffix + "  ").andExpect(status().isOk()));

        assertThat(updated.path("id").asString()).isEqualTo(id.toString());
        assertThat(updated.path("name").asString()).isEqualTo("New Tag " + suffix);
        assertThat(updated.path("slug").asString()).isEqualTo(slug);

        // Public side, no token: list and tag page carry the new name under the old slug; a new name does not
        // generate a slug.
        JsonNode entry = findById(data(mockMvc.perform(get(PUBLIC_TAGS)).andExpect(status().isOk())), id);
        assertThat(entry.path("name").asString()).isEqualTo("New Tag " + suffix);
        assertThat(entry.path("slug").asString()).isEqualTo(slug);
        assertThat(data(mockMvc.perform(get(PUBLIC_TAGS + "/" + slug)).andExpect(status().isOk()))
                        .path("name")
                        .asString())
                .isEqualTo("New Tag " + suffix);
        assertError(mockMvc.perform(get(PUBLIC_TAGS + "/the-moi-" + suffix)), 404, "TAG_NOT_FOUND");
        // The post still carries the tag: filtering by the old slug still returns it, and the tag on the post
        // carries the new name.
        JsonNode posts =
                data(mockMvc.perform(get("/api/v1/posts").param("tag", slug)).andExpect(status().isOk()));
        assertThat(idsOf(posts)).containsExactly(post.toString());
        assertThat(posts.get(0).path("tags").get(0).path("name").asString()).isEqualTo("New Tag " + suffix);
    }

    @Test
    void duplicate_name_of_other_tag_case_insensitive_is_409_but_recasing_own_name_is_allowed() throws Exception {
        String taken = "Owned Tag " + suffix;
        JsonNode first = data(createTag(taken).andExpect(status().isCreated()));
        UUID second = idOf(data(createTag("Other Tag " + suffix).andExpect(status().isCreated())));

        assertError(updateTag(second, "  " + taken.toUpperCase(Locale.ROOT) + "  "), 409, "TAG_ALREADY_EXISTS");
        assertThat(findById(adminList(), second).path("name").asString()).isEqualTo("Other Tag " + suffix);

        // Only recasing its own name does not clash with any other tag, and the slug stays unchanged.
        JsonNode renamed =
                data(updateTag(idOf(first), taken.toLowerCase(Locale.ROOT)).andExpect(status().isOk()));
        assertThat(renamed.path("name").asString()).isEqualTo(taken.toLowerCase(Locale.ROOT));
        assertThat(renamed.path("slug").asString()).isEqualTo(first.path("slug").asString());
    }

    @Test
    void unknown_tag_is_404_and_invalid_request_body_is_400_VALIDATION_ERROR() throws Exception {
        UUID missing = UUID.randomUUID();
        assertError(updateTag(missing, "Missing " + suffix), 404, "TAG_NOT_FOUND");
        assertError(deleteTag(missing), 404, "TAG_NOT_FOUND");

        String name = "Body Check " + suffix;
        UUID id = idOf(data(createTag(name).andExpect(status().isCreated())));
        assertError(updateTag(id, "   "), 400, "VALIDATION_ERROR");
        assertError(putJson(ADMIN_TAGS + "/" + id, "{}"), 400, "VALIDATION_ERROR");
        assertError(updateTag(id, suffix + "x".repeat(101 - suffix.length())), 400, "VALIDATION_ERROR");
        assertError(putJson(ADMIN_TAGS + "/" + id, "{\"name\":"), 400, "VALIDATION_ERROR");
        // None of the calls above wrote anything.
        assertThat(findById(adminList(), id).path("name").asString()).isEqualTo(name);

        // Control: exactly 100 characters is valid, so the 400 above is due to the length and not to the
        // name.
        String longest = suffix + "x".repeat(100 - suffix.length());
        assertThat(data(updateTag(id, longest).andExpect(status().isOk()))
                        .path("name")
                        .asString())
                .isEqualTo(longest);
    }

    // --- Delete ------------------------------------------------------------------------------------

    @Test
    void delete_tag_attached_to_posts_returns_204_tag_leaves_posts_and_posts_stay_intact() throws Exception {
        JsonNode doomed = data(createTag("Tag To Delete " + suffix).andExpect(status().isCreated()));
        UUID doomedId = idOf(doomed);
        String doomedSlug = doomed.path("slug").asString();
        UUID kept = idOf(data(createTag("Tag That Stays " + suffix).andExpect(status().isCreated())));
        UUID post = createPost("Post losing a tag", List.of(doomedId, kept));
        publish(post);
        JsonNode before = adminPost(post);
        assertThat(idsOf(before.path("tags"))).containsExactlyInAnyOrder(doomedId.toString(), kept.toString());

        deleteTag(doomedId).andExpect(status().isNoContent());

        // The tag disappears from the public side and from the admin list.
        assertError(mockMvc.perform(get(PUBLIC_TAGS + "/" + doomedSlug)), 404, "TAG_NOT_FOUND");
        assertThat(idsOf(data(mockMvc.perform(get(PUBLIC_TAGS)).andExpect(status().isOk()))))
                .doesNotContain(doomedId.toString());
        assertThat(idsOf(adminList())).doesNotContain(doomedId.toString());
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM post_tags WHERE tag_id = ?", Long.class, doomedId))
                .isZero();

        // The post stays intact, only without that tag, on both the admin and the public page.
        JsonNode after = adminPost(post);
        assertThat(after.path("title").asString())
                .isEqualTo(before.path("title").asString());
        assertThat(after.path("slug").asString()).isEqualTo(before.path("slug").asString());
        assertThat(after.path("status").asString()).isEqualTo("PUBLISHED");
        assertThat(after.path("category").path("id").asString()).isEqualTo(categoryId.toString());
        assertThat(idsOf(after.path("tags"))).containsExactly(kept.toString());
        // Removing a site tag is editorial work, not a post edit: updatedAt stays put.
        assertThat(after.path("updatedAt").asString())
                .isEqualTo(before.path("updatedAt").asString());
        JsonNode publicPost =
                data(mockMvc.perform(get("/api/v1/posts/" + before.path("slug").asString()))
                        .andExpect(status().isOk()));
        assertThat(idsOf(publicPost.path("tags"))).containsExactly(kept.toString());
        // Delete again: the tag is gone.
        assertError(deleteTag(doomedId), 404, "TAG_NOT_FOUND");
    }

    @Test
    void two_overlapping_deletes_make_the_second_wait_then_return_404_not_500() throws Exception {
        UUID id = idOf(data(createTag("Delete Twice " + suffix).andExpect(status().isCreated())));

        CountDownLatch firstDeleted = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            // The first delete (repeated click, two tabs) is in progress: the DELETE already ran, holds the
            // row lock of the tag, not committed.
            Future<?> first =
                    pool.submit(() -> new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                        jdbcTemplate.update("DELETE FROM tags WHERE id = ?", id);
                        firstDeleted.countDown();
                        awaitQuietly(releaseFirst);
                    }));
            assertThat(firstDeleted.await(10, TimeUnit.SECONDS)).isTrue();

            Future<MvcResult> second = pool.submit(() -> deleteTag(id).andReturn());
            // Control that the two deletes really overlap: the second is waiting, not finished.
            assertThatThrownBy(() -> second.get(500, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
            releaseFirst.countDown();
            first.get(10, TimeUnit.SECONDS);
            MvcResult result = second.get(30, TimeUnit.SECONDS);

            // Without the lock the second would see the tag (the first has not committed), then its DELETE
            // hits 0 rows: Hibernate treats that as a write conflict, and the request becomes a 500.
            String body = result.getResponse().getContentAsString();
            assertThat(result.getResponse().getStatus()).as(body).isEqualTo(404);
            assertThat(objectMapper.readTree(body).path("error").path("code").asString())
                    .isEqualTo("TAG_NOT_FOUND");
        } finally {
            releaseFirst.countDown();
            pool.shutdownNow();
        }
    }

    // --- Merge ---------------------------------------------------------------------------

    @Test
    void merge_moves_every_post_to_target_tag_post_with_both_keeps_target_once_and_updatedAt_stays_put()
            throws Exception {
        JsonNode source = data(createTag("Source Tag " + suffix).andExpect(status().isCreated()));
        UUID sourceId = idOf(source);
        JsonNode target = data(createTag("Target Tag " + suffix).andExpect(status().isCreated()));
        UUID targetId = idOf(target);
        UUID otherId = idOf(data(createTag("Neighbor Tag " + suffix).andExpect(status().isCreated())));
        UUID onlySource = createPost("Post with only the source tag", List.of(sourceId));
        publish(onlySource);
        UUID both = createPost("Draft with both tags", List.of(sourceId, targetId));
        UUID onlyTarget = createPost("Post with only the target tag", List.of(targetId));
        UUID withOther = createPost("Post with the source and neighbor tags", List.of(sourceId, otherId));
        Map<UUID, String> updatedBefore = new LinkedHashMap<>();
        for (UUID post : List.of(onlySource, both, onlyTarget, withOther)) {
            updatedBefore.put(post, adminPost(post).path("updatedAt").asString());
        }

        JsonNode merged = data(mergeTag(sourceId, targetId).andExpect(status().isOk()));

        // The target tag as the admin list returns it, and the number of posts that carried the source tag
        // (every status), including posts that already had the target tag.
        assertThat(merged.propertyNames()).containsExactlyInAnyOrder("target", "moved");
        assertThat(merged.path("target")).isEqualTo(target);
        assertThat(merged.path("moved").asLong()).isEqualTo(3);

        assertThat(idsOf(adminPost(onlySource).path("tags"))).containsExactly(targetId.toString());
        // A post carrying both: the target tag exactly once, not twice.
        assertThat(idsOf(adminPost(both).path("tags"))).containsExactly(targetId.toString());
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM post_tags WHERE post_id = ? AND tag_id = ?", Long.class, both, targetId))
                .isEqualTo(1);
        assertThat(idsOf(adminPost(onlyTarget).path("tags"))).containsExactly(targetId.toString());
        assertThat(idsOf(adminPost(withOther).path("tags")))
                .containsExactlyInAnyOrder(otherId.toString(), targetId.toString());
        // Merging tags is editorial work, not a post edit: updatedAt of every post stays put.
        for (Map.Entry<UUID, String> post : updatedBefore.entrySet()) {
            assertThat(adminPost(post.getKey()).path("updatedAt").asString())
                    .as("updatedAt of %s", post.getKey())
                    .isEqualTo(post.getValue());
        }

        // The source tag disappears everywhere; the public page of the target tag has the published posts.
        assertThat(idsOf(adminList())).doesNotContain(sourceId.toString()).contains(targetId.toString());
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM post_tags WHERE tag_id = ?", Long.class, sourceId))
                .isZero();
        assertError(mockMvc.perform(get(PUBLIC_TAGS + "/" + source.path("slug").asString())), 404, "TAG_NOT_FOUND");
        assertThat(idsOf(data(mockMvc.perform(get("/api/v1/posts")
                                .param("tag", target.path("slug").asString()))
                        .andExpect(status().isOk()))))
                .containsExactly(onlySource.toString());
        // Merge again: the source tag is gone.
        assertError(mergeTag(sourceId, targetId), 404, "TAG_NOT_FOUND");
    }

    @Test
    void source_tag_attached_to_post_during_merge_makes_merge_wait_then_move_that_post_too() throws Exception {
        UUID sourceId = idOf(data(createTag("Merge Source Midway " + suffix).andExpect(status().isCreated())));
        UUID targetId = idOf(data(createTag("Merge Target Midway " + suffix).andExpect(status().isCreated())));
        UUID post = createPost("Post tagged during the merge", List.of());

        CountDownLatch tagged = new CountDownLatch(1);
        CountDownLatch releaseTagging = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            // A post save in progress: the source tag is attached (Postgres has checked the foreign key and
            // holds FOR KEY SHARE on the tag row), not committed.
            Future<?> tagging =
                    pool.submit(() -> new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                        jdbcTemplate.update("INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)", post, sourceId);
                        tagged.countDown();
                        awaitQuietly(releaseTagging);
                    }));
            assertThat(tagged.await(10, TimeUnit.SECONDS)).isTrue();

            Future<MvcResult> merge =
                    pool.submit(() -> mergeTag(sourceId, targetId).andReturn());
            // Control that the two writes really overlap: the merge is waiting for the FOR UPDATE lock, not
            // finished.
            assertThatThrownBy(() -> merge.get(500, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
            releaseTagging.countDown();
            tagging.get(10, TimeUnit.SECONDS);
            MvcResult result = merge.get(30, TimeUnit.SECONDS);

            // A lock weaker than FOR UPDATE does not wait for the attachment: the copy statement does not see
            // the uncommitted row, then deleting the source tag cascades that row away (ON DELETE CASCADE),
            // and the post loses the tag without receiving the target tag.
            String body = result.getResponse().getContentAsString();
            assertThat(result.getResponse().getStatus()).as(body).isEqualTo(200);
            assertThat(objectMapper.readTree(body).path("data").path("moved").asLong())
                    .isEqualTo(1);
        } finally {
            releaseTagging.countDown();
            pool.shutdownNow();
        }
        assertThat(idsOf(adminPost(post).path("tags"))).containsExactly(targetId.toString());
    }

    @Test
    void merge_of_tag_attached_to_no_post_returns_moved_0_and_still_deletes_source_tag() throws Exception {
        UUID sourceId = idOf(data(createTag("Empty Tag " + suffix).andExpect(status().isCreated())));
        UUID targetId = idOf(data(createTag("Empty Receiving Tag " + suffix).andExpect(status().isCreated())));

        JsonNode merged = data(mergeTag(sourceId, targetId).andExpect(status().isOk()));

        assertThat(merged.path("moved").asLong()).isZero();
        assertThat(merged.path("target").path("id").asString()).isEqualTo(targetId.toString());
        assertThat(idsOf(adminList())).doesNotContain(sourceId.toString());
    }

    @Test
    void merge_into_itself_or_bad_body_is_400_missing_target_tag_is_400_missing_source_tag_is_404_and_nothing_changes()
            throws Exception {
        UUID sourceId = idOf(data(createTag("Kept Tag " + suffix).andExpect(status().isCreated())));
        UUID post = createPost("Post keeping its tag when the merge fails", List.of(sourceId));
        String one = ADMIN_TAGS + "/" + sourceId + "/merge";

        assertError(mergeTag(sourceId, sourceId), 400, "VALIDATION_ERROR");
        assertError(mergeTag(sourceId, UUID.randomUUID()), 400, "TAG_NOT_FOUND");
        assertError(postJson(one, "{}"), 400, "VALIDATION_ERROR");
        assertError(postJson(one, "{\"targetId\":\"khong-phai-uuid\"}"), 400, "VALIDATION_ERROR");
        assertError(
                postJson(ADMIN_TAGS + "/khong-phai-uuid/merge", json(Map.of("targetId", sourceId))),
                400,
                "VALIDATION_ERROR");
        // Missing source: 404, even when the target is real.
        assertError(mergeTag(UUID.randomUUID(), sourceId), 404, "TAG_NOT_FOUND");

        // None of the calls above wrote anything.
        assertThat(idsOf(adminList())).contains(sourceId.toString());
        assertThat(idsOf(adminPost(post).path("tags"))).containsExactly(sourceId.toString());
    }

    @Test
    void only_admin_can_merge_author_gets_403_no_token_gets_401() throws Exception {
        String author = auth.bearerFor(auth.createAuthor("tag-merge-" + suffix + "@blog.local"));
        UUID sourceId = idOf(data(createTag("Permission Source " + suffix).andExpect(status().isCreated())));
        UUID targetId = idOf(data(createTag("Permission Target " + suffix).andExpect(status().isCreated())));
        String body = json(Map.of("targetId", targetId));

        assertError(
                mockMvc.perform(post(ADMIN_TAGS + "/" + sourceId + "/merge")
                        .header("Authorization", author)
                        .contentType(APPLICATION_JSON)
                        .content(body)),
                403,
                "FORBIDDEN");
        assertError(
                mockMvc.perform(post(ADMIN_TAGS + "/" + sourceId + "/merge")
                        .contentType(APPLICATION_JSON)
                        .content(body)),
                401,
                "UNAUTHENTICATED");

        assertThat(idsOf(adminList())).contains(sourceId.toString(), targetId.toString());
    }

    // --- Permissions -------------------------------------------------------------------------------

    @Test
    void only_admin_can_edit_and_delete_author_gets_403_no_token_gets_401_while_view_and_create_stay_open_to_author()
            throws Exception {
        String author = auth.bearerFor(auth.createAuthor("tag-" + suffix + "@blog.local"));
        String name = "Tag Permission " + suffix;
        UUID id = idOf(data(createTag(name).andExpect(status().isCreated())));
        String one = ADMIN_TAGS + "/" + id;

        // AUTHOR can still view and create: the post editor creates tags in place.
        mockMvc.perform(get(ADMIN_TAGS).header("Authorization", author)).andExpect(status().isOk());
        mockMvc.perform(post(ADMIN_TAGS)
                        .header("Authorization", author)
                        .contentType(APPLICATION_JSON)
                        .content(json(Map.of("name", "Author Own Tag " + suffix))))
                .andExpect(status().isCreated());

        assertError(
                mockMvc.perform(put(one).header("Authorization", author)
                        .contentType(APPLICATION_JSON)
                        .content(json(Map.of("name", "Author Rename " + suffix)))),
                403,
                "FORBIDDEN");
        assertError(mockMvc.perform(delete(one).header("Authorization", author)), 403, "FORBIDDEN");
        assertError(
                mockMvc.perform(delete(ADMIN_TAGS + "/" + UUID.randomUUID()).header("Authorization", author)),
                403,
                "FORBIDDEN");
        assertError(
                mockMvc.perform(
                        put(one).contentType(APPLICATION_JSON).content(json(Map.of("name", "Anonymous " + suffix)))),
                401,
                "UNAUTHENTICATED");
        assertError(mockMvc.perform(delete(one)), 401, "UNAUTHENTICATED");

        // None of the calls above touched the tag.
        assertThat(findById(adminList(), id).path("name").asString()).isEqualTo(name);
    }

    // --- Checks ------------------------------------------------------------------------------------

    private void assertError(ResultActions result, int status, String code) throws Exception {
        result.andExpect(status().is(status));
        JsonNode error = objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("error");
        assertThat(error.path("code").asString()).isEqualTo(code);
    }

    // --- Reads -------------------------------------------------------------------------------------

    private JsonNode adminList() throws Exception {
        return data(
                mockMvc.perform(get(ADMIN_TAGS).header("Authorization", admin)).andExpect(status().isOk()));
    }

    private JsonNode adminPost(UUID id) throws Exception {
        return data(mockMvc.perform(get("/api/v1/admin/posts/" + id).header("Authorization", admin))
                .andExpect(status().isOk()));
    }

    private static List<String> idsOf(JsonNode array) {
        List<String> ids = new ArrayList<>();
        array.forEach(node -> ids.add(node.path("id").asString()));
        return ids;
    }

    private static JsonNode findById(JsonNode array, UUID id) {
        for (JsonNode node : array) {
            if (id.toString().equals(node.path("id").asString())) {
                return node;
            }
        }
        throw new AssertionError("Tag not found: " + id + " in the list");
    }

    private static UUID idOf(JsonNode node) {
        return UUID.fromString(node.path("id").asString());
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("data");
    }

    // --- Ghi ---------------------------------------------------------------------------------------

    private String json(Object body) throws Exception {
        return objectMapper.writeValueAsString(body);
    }

    private ResultActions createTag(String name) throws Exception {
        return mockMvc.perform(post(ADMIN_TAGS)
                .header("Authorization", admin)
                .contentType(APPLICATION_JSON)
                .content(json(Map.of("name", name))));
    }

    private ResultActions updateTag(UUID id, String name) throws Exception {
        return putJson(ADMIN_TAGS + "/" + id, json(Map.of("name", name)));
    }

    private ResultActions putJson(String path, String json) throws Exception {
        return mockMvc.perform(put(path)
                .header("Authorization", admin)
                .contentType(APPLICATION_JSON)
                .content(json));
    }

    private ResultActions deleteTag(UUID id) throws Exception {
        return mockMvc.perform(delete(ADMIN_TAGS + "/" + id).header("Authorization", admin));
    }

    private ResultActions mergeTag(UUID sourceId, UUID targetId) throws Exception {
        return postJson(ADMIN_TAGS + "/" + sourceId + "/merge", json(Map.of("targetId", targetId)));
    }

    private ResultActions postJson(String path, String json) throws Exception {
        return mockMvc.perform(post(path)
                .header("Authorization", admin)
                .contentType(APPLICATION_JSON)
                .content(json));
    }

    /** An admin draft in the category of the test, with the given tags attached. */
    private UUID createPost(String title, List<UUID> tagIds) throws Exception {
        String payload = json(Map.of(
                "title",
                title + " " + suffix,
                "excerpt",
                "Summary " + suffix,
                "content",
                String.join(" ", Collections.nCopies(12, "word")),
                "categoryId",
                categoryId.toString(),
                "tagIds",
                tagIds));
        return idOf(data(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated())));
    }

    private void publish(UUID post) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + post + "/publish").header("Authorization", admin))
                .andExpect(status().isOk());
    }

    private static void awaitQuietly(CountDownLatch latch) {
        try {
            latch.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
