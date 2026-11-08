package com.blog.category;

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
import java.util.HashMap;
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
 * Edit, delete and merge categories: {@code PUT}/{@code DELETE /api/v1/admin/categories/{id}} and
 * {@code POST /api/v1/admin/categories/{id}/merge}, ADMIN only.
 *
 * The slug is the public URL {@code /categories/{slug}}, so renaming never changes it. Deleting is allowed
 * only when no post uses the category, in any status (409 {@code CATEGORY_IN_USE}), even a post assigned
 * during the delete. Merging is "move the posts, then delete": every post of the source category, in every
 * status, goes to the target category, then the source is deleted, without touching the {@code updated_at} of
 * any post.
 *
 * Every request goes through the real filter chain with a real token: the edit and delete permissions are
 * {@code @PreAuthorize} on the controller, and a test that pre-sets a SecurityContext would pass even if it
 * were removed.
 *
 * The shared DB is never cleaned: every name has a random suffix; the category list is only checked for
 * presence or absence, never for length. Post text avoids every word that PostSearchAndFeaturedIT searches
 * for.
 */
@AutoConfigureMockMvc
class CategoryAdminIT extends AbstractIntegrationTest {

    private static final String ADMIN_CATEGORIES = "/api/v1/admin/categories";
    private static final String PUBLIC_CATEGORIES = "/api/v1/categories";

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

    @BeforeEach
    void setUp() {
        admin = auth.bearerForAdmin();
        suffix = UUID.randomUUID().toString().substring(0, 8);
    }

    // --- Edit --------------------------------------------------------------------------------------

    @Test
    void rename_returns_200_slug_unchanged_and_public_side_shows_new_name_under_old_slug() throws Exception {
        JsonNode created = data(createCategory(Map.of("name", "Old Name " + suffix, "description", "Old description."))
                .andExpect(status().isCreated()));
        UUID id = idOf(created);
        String slug = created.path("slug").asString();
        assertThat(slug).isEqualTo("old-name-" + suffix);
        // A published post in the category: the public category page must survive the rename.
        UUID post = createPost("Post of the renamed category", id);
        publish(post);

        JsonNode updated = data(
                updateCategory(id, Map.of("name", "  New Name " + suffix + "  ", "description", "  New description.  "))
                        .andExpect(status().isOk()));

        assertThat(updated.path("id").asString()).isEqualTo(id.toString());
        assertThat(updated.path("name").asString()).isEqualTo("New Name " + suffix);
        assertThat(updated.path("slug").asString()).isEqualTo(slug);
        assertThat(updated.path("description").asString()).isEqualTo("New description.");

        // Public side, no token: list and category page carry the new name under the old slug; no new slug.
        JsonNode entry = findById(data(mockMvc.perform(get(PUBLIC_CATEGORIES)).andExpect(status().isOk())), id);
        assertThat(entry.path("name").asString()).isEqualTo("New Name " + suffix);
        assertThat(entry.path("slug").asString()).isEqualTo(slug);
        JsonNode page =
                data(mockMvc.perform(get(PUBLIC_CATEGORIES + "/" + slug)).andExpect(status().isOk()));
        assertThat(page.path("name").asString()).isEqualTo("New Name " + suffix);
        assertThat(page.path("description").asString()).isEqualTo("New description.");
        assertError(mockMvc.perform(get(PUBLIC_CATEGORIES + "/ten-moi-" + suffix)), 404, "CATEGORY_NOT_FOUND");
        // The post is still in the category: filtering by the old slug still returns it, and it carries the
        // new name.
        JsonNode posts = data(
                mockMvc.perform(get("/api/v1/posts").param("category", slug)).andExpect(status().isOk()));
        assertThat(idsOf(posts)).containsExactly(post.toString());
        assertThat(posts.get(0).path("category").path("name").asString()).isEqualTo("New Name " + suffix);
    }

    @Test
    void description_is_fully_replaced_empty_blank_or_omitted_all_become_null() throws Exception {
        String name = "With Description " + suffix;
        JsonNode created = data(createCategory(Map.of("name", name, "description", "Initial description."))
                .andExpect(status().isCreated()));
        UUID id = idOf(created);

        JsonNode blank = data(
                updateCategory(id, Map.of("name", name, "description", "  \n ")).andExpect(status().isOk()));
        assertThat(blank.path("description").isNull()).isTrue();

        JsonNode again = data(updateCategory(id, Map.of("name", name, "description", "Back again."))
                .andExpect(status().isOk()));
        assertThat(again.path("description").asString()).isEqualTo("Back again.");
        // Omitting the description clears it: PUT replaces the whole resource.
        JsonNode omitted = data(updateCategory(id, Map.of("name", name)).andExpect(status().isOk()));
        assertThat(omitted.path("description").isNull()).isTrue();

        // Read back from the DB via the public page, not just trusting the write response. The public side
        // only shows categories with a published post, so the category gets a post first.
        publish(createPost("Post of the category with a description", id));
        JsonNode stored = data(mockMvc.perform(
                        get(PUBLIC_CATEGORIES + "/" + created.path("slug").asString()))
                .andExpect(status().isOk()));
        assertThat(stored.path("description").isNull()).isTrue();
        assertThat(stored.path("name").asString()).isEqualTo(name);
    }

    @Test
    void duplicate_name_of_other_category_case_insensitive_is_409_but_recasing_own_name_is_allowed() throws Exception {
        String taken = "Already Owned " + suffix;
        JsonNode first = data(createCategory(Map.of("name", taken)).andExpect(status().isCreated()));
        UUID second =
                idOf(data(createCategory(Map.of("name", "Other Name " + suffix)).andExpect(status().isCreated())));

        assertError(
                updateCategory(second, Map.of("name", "  " + taken.toUpperCase(Locale.ROOT) + "  ")),
                409,
                "CATEGORY_ALREADY_EXISTS");
        assertThat(findById(adminList(), second).path("name").asString()).isEqualTo("Other Name " + suffix);

        // Only recasing its own name does not clash with any other category, and the slug stays unchanged.
        JsonNode renamed = data(updateCategory(idOf(first), Map.of("name", taken.toLowerCase(Locale.ROOT)))
                .andExpect(status().isOk()));
        assertThat(renamed.path("name").asString()).isEqualTo(taken.toLowerCase(Locale.ROOT));
        assertThat(renamed.path("slug").asString()).isEqualTo(first.path("slug").asString());
        // Sending the name it already has is the same (saving the form without changes).
        updateCategory(idOf(first), Map.of("name", taken.toLowerCase(Locale.ROOT)))
                .andExpect(status().isOk());
    }

    @Test
    void unknown_category_is_404_and_invalid_request_body_is_400_VALIDATION_ERROR() throws Exception {
        UUID missing = UUID.randomUUID();
        assertError(updateCategory(missing, Map.of("name", "Missing " + suffix)), 404, "CATEGORY_NOT_FOUND");
        assertError(deleteCategory(missing), 404, "CATEGORY_NOT_FOUND");

        String name = "Body Check " + suffix;
        UUID id = idOf(data(createCategory(Map.of("name", name)).andExpect(status().isCreated())));
        assertError(updateCategory(id, Map.of("name", "   ")), 400, "VALIDATION_ERROR");
        assertError(updateCategory(id, Map.of("description", "No name")), 400, "VALIDATION_ERROR");
        assertError(
                updateCategory(id, Map.of("name", suffix + "x".repeat(256 - suffix.length()))),
                400,
                "VALIDATION_ERROR");
        assertError(putJson(ADMIN_CATEGORIES + "/" + id, "{\"name\":"), 400, "VALIDATION_ERROR");
        assertError(
                putJson(ADMIN_CATEGORIES + "/khong-phai-uuid", json(Map.of("name", "Id Sai " + suffix))),
                400,
                "VALIDATION_ERROR");
        // None of the calls above wrote anything.
        assertThat(findById(adminList(), id).path("name").asString()).isEqualTo(name);

        // Control: exactly 255 characters is valid, so the 400 above is due to the length and not to the
        // name.
        String longest = suffix + "x".repeat(255 - suffix.length());
        JsonNode updated = data(updateCategory(id, Map.of("name", longest)).andExpect(status().isOk()));
        assertThat(updated.path("name").asString()).isEqualTo(longest);
    }

    // --- Delete ------------------------------------------------------------------------------------

    @Test
    void delete_category_used_by_no_post_returns_204_and_it_disappears() throws Exception {
        String name = "To Be Deleted " + suffix;
        JsonNode created = data(createCategory(Map.of("name", name)).andExpect(status().isCreated()));
        UUID id = idOf(created);
        String slug = created.path("slug").asString();

        deleteCategory(id).andExpect(status().isNoContent());

        assertError(mockMvc.perform(get(PUBLIC_CATEGORIES + "/" + slug)), 404, "CATEGORY_NOT_FOUND");
        assertThat(idsOf(data(mockMvc.perform(get(PUBLIC_CATEGORIES)).andExpect(status().isOk()))))
                .doesNotContain(id.toString());
        assertThat(idsOf(adminList())).doesNotContain(id.toString());
        // Delete again (repeated click): the category is gone.
        assertError(deleteCategory(id), 404, "CATEGORY_NOT_FOUND");
        // The row is really gone: name and slug are released, and re-creating the same name gets the same old
        // slug back.
        JsonNode recreated = data(createCategory(Map.of("name", name)).andExpect(status().isCreated()));
        assertThat(recreated.path("slug").asString()).isEqualTo(slug);
    }

    @Test
    void delete_category_still_used_even_by_draft_is_409_CATEGORY_IN_USE_and_nothing_changes() throws Exception {
        String name = "Has Posts " + suffix;
        JsonNode created = data(createCategory(Map.of("name", name)).andExpect(status().isCreated()));
        UUID id = idOf(created);
        String slug = created.path("slug").asString();
        // Only a draft uses it: the public side sees no post in the category, and not the
        // category itself either; but the foreign key does.
        UUID draft = createPost("Draft keeping the category", id);
        assertError(mockMvc.perform(get(PUBLIC_CATEGORIES + "/" + slug)), 404, "CATEGORY_NOT_FOUND");

        JsonNode oneUse = assertError(deleteCategory(id), 409, "CATEGORY_IN_USE");
        assertThat(oneUse.path("message").asString()).isEqualTo("Category '" + name + "' is used by 1 post");

        UUID published = createPost("Public post keeping the category", id);
        publish(published);
        JsonNode twoUses = assertError(deleteCategory(id), 409, "CATEGORY_IN_USE");
        assertThat(twoUses.path("message").asString()).isEqualTo("Category '" + name + "' is used by 2 posts");

        // Nothing changed: the category is on the public page, both posts are in it, the published one still
        // shows.
        mockMvc.perform(get(PUBLIC_CATEGORIES + "/" + slug)).andExpect(status().isOk());
        for (UUID post : List.of(draft, published)) {
            assertThat(adminPost(post).path("category").path("id").asString()).isEqualTo(id.toString());
        }
        assertThat(idsOf(data(mockMvc.perform(get("/api/v1/posts").param("category", slug))
                        .andExpect(status().isOk()))))
                .containsExactly(published.toString());

        // Control: moving both posts to another category makes deletion possible, and both posts stay intact
        // there.
        UUID other = idOf(
                data(createCategory(Map.of("name", "Move Target " + suffix)).andExpect(status().isCreated())));
        for (UUID post : List.of(draft, published)) {
            movePost(post, other);
        }
        deleteCategory(id).andExpect(status().isNoContent());
        for (UUID post : List.of(draft, published)) {
            assertThat(adminPost(post).path("category").path("id").asString()).isEqualTo(other.toString());
        }
        assertThat(adminPost(published).path("status").asString()).isEqualTo("PUBLISHED");
    }

    @Test
    void post_assigned_during_delete_makes_delete_wait_then_return_409_CATEGORY_IN_USE() throws Exception {
        String name = "Assigned Midway " + suffix;
        UUID id = idOf(data(createCategory(Map.of("name", name)).andExpect(status().isCreated())));
        UUID post = createPost("Post assigned midway", null);

        CountDownLatch assignmentChecked = new CountDownLatch(1);
        CountDownLatch releaseAssignment = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            // A post save in progress: the post was moved into the category, so Postgres has checked the
            // foreign key and holds FOR KEY SHARE on the category row; not committed, so no committed post is
            // in the category yet.
            Future<?> assignment =
                    pool.submit(() -> new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                        jdbcTemplate.update("UPDATE posts SET category_id = ? WHERE id = ?", id, post);
                        assignmentChecked.countDown();
                        awaitQuietly(releaseAssignment);
                    }));
            assertThat(assignmentChecked.await(10, TimeUnit.SECONDS)).isTrue();

            Future<MvcResult> deletion = pool.submit(() -> deleteCategory(id).andReturn());
            // Control that the two writes really overlap: the delete is waiting, not finished.
            assertThatThrownBy(() -> deletion.get(500, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
            releaseAssignment.countDown();
            assignment.get(10, TimeUnit.SECONDS);
            MvcResult result = deletion.get(30, TimeUnit.SECONDS);

            // A lock weaker than FOR UPDATE (the Hibernate PESSIMISTIC_WRITE is FOR NO KEY UPDATE) does not
            // wait for the assignment: the delete counts 0 posts, then the DELETE hits the foreign key at
            // commit: generic 409.
            String body = result.getResponse().getContentAsString();
            assertThat(result.getResponse().getStatus()).as(body).isEqualTo(409);
            JsonNode error = objectMapper.readTree(body).path("error");
            assertThat(error.path("code").asString()).isEqualTo("CATEGORY_IN_USE");
            assertThat(error.path("message").asString()).isEqualTo("Category '" + name + "' is used by 1 post");
        } finally {
            releaseAssignment.countDown();
            pool.shutdownNow();
        }
        // The assignment stays in effect: the category exists, and the post is in it.
        assertThat(findById(adminList(), id).path("name").asString()).isEqualTo(name);
        assertThat(adminPost(post).path("category").path("id").asString()).isEqualTo(id.toString());
    }

    // --- Merge ---------------------------------------------------------------------------

    @Test
    void merge_moves_every_post_even_drafts_to_target_then_deletes_source_and_updatedAt_stays_put() throws Exception {
        JsonNode source =
                data(createCategory(Map.of("name", "Merge Source " + suffix)).andExpect(status().isCreated()));
        UUID sourceId = idOf(source);
        JsonNode target =
                data(createCategory(Map.of("name", "Merge Target " + suffix)).andExpect(status().isCreated()));
        UUID targetId = idOf(target);
        UUID draft = createPost("Draft of the source category", sourceId);
        UUID published = createPost("Published post of the source category", sourceId);
        publish(published);
        UUID alreadyThere = createPost("Post already in the target category", targetId);
        publish(alreadyThere);
        JsonNode draftBefore = adminPost(draft);
        JsonNode publishedBefore = adminPost(published);

        JsonNode merged = data(mergeCategory(sourceId, targetId).andExpect(status().isOk()));

        assertThat(merged.propertyNames()).containsExactlyInAnyOrder("target", "moved");
        // An empty description is null, as everywhere else a category is returned.
        assertThat(merged.path("target")).isEqualTo(target);
        assertThat(merged.path("moved").asLong()).isEqualTo(2);

        for (UUID post : List.of(draft, published, alreadyThere)) {
            assertThat(adminPost(post).path("category").path("id").asString())
                    .as("category of %s", post)
                    .isEqualTo(targetId.toString());
        }
        // Bulk category moves are editorial work, not post edits: updatedAt, status and publish date stay
        // put.
        for (JsonNode before : List.of(draftBefore, publishedBefore)) {
            JsonNode after = adminPost(idOf(before));
            for (String field : List.of("updatedAt", "status", "publishedAt", "slug")) {
                assertThat(after.path(field))
                        .as("%s of %s", field, idOf(before))
                        .isEqualTo(before.path(field));
            }
        }

        // The source is gone (it was empty, so it can be deleted); the target public page has both published
        // posts.
        assertThat(idsOf(adminList())).doesNotContain(sourceId.toString()).contains(targetId.toString());
        assertError(
                mockMvc.perform(
                        get(PUBLIC_CATEGORIES + "/" + source.path("slug").asString())),
                404,
                "CATEGORY_NOT_FOUND");
        assertThat(idsOf(data(mockMvc.perform(get("/api/v1/posts")
                                .param("category", target.path("slug").asString()))
                        .andExpect(status().isOk()))))
                .containsExactlyInAnyOrder(published.toString(), alreadyThere.toString());
        // Merge again: the source no longer exists.
        assertError(mergeCategory(sourceId, targetId), 404, "CATEGORY_NOT_FOUND");
    }

    @Test
    void post_assigned_to_source_during_merge_makes_merge_wait_then_move_it_too() throws Exception {
        UUID sourceId = idOf(data(
                createCategory(Map.of("name", "Merge Source Midway " + suffix)).andExpect(status().isCreated())));
        UUID targetId = idOf(data(
                createCategory(Map.of("name", "Merge Target Midway " + suffix)).andExpect(status().isCreated())));
        UUID post = createPost("Post assigned during the merge", null);

        CountDownLatch assignmentChecked = new CountDownLatch(1);
        CountDownLatch releaseAssignment = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            // A post save in progress: the post was moved into the source category (Postgres has checked the
            // foreign key and holds FOR KEY SHARE on the category row), not committed.
            Future<?> assignment =
                    pool.submit(() -> new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                        jdbcTemplate.update("UPDATE posts SET category_id = ? WHERE id = ?", sourceId, post);
                        assignmentChecked.countDown();
                        awaitQuietly(releaseAssignment);
                    }));
            assertThat(assignmentChecked.await(10, TimeUnit.SECONDS)).isTrue();

            Future<MvcResult> merge =
                    pool.submit(() -> mergeCategory(sourceId, targetId).andReturn());
            // Control that the two writes really overlap: the merge is waiting for the FOR UPDATE lock, not
            // finished.
            assertThatThrownBy(() -> merge.get(500, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
            releaseAssignment.countDown();
            assignment.get(10, TimeUnit.SECONDS);
            MvcResult result = merge.get(30, TimeUnit.SECONDS);

            // A lock weaker than FOR UPDATE does not wait for the assignment: the merge moves 0 posts, then
            // deleting the source hits the foreign key because the post was just assigned, and the whole
            // merge becomes 409.
            String body = result.getResponse().getContentAsString();
            assertThat(result.getResponse().getStatus()).as(body).isEqualTo(200);
            assertThat(objectMapper.readTree(body).path("data").path("moved").asLong())
                    .isEqualTo(1);
        } finally {
            releaseAssignment.countDown();
            pool.shutdownNow();
        }
        assertThat(adminPost(post).path("category").path("id").asString()).isEqualTo(targetId.toString());
        assertThat(idsOf(adminList())).doesNotContain(sourceId.toString());
    }

    @Test
    void merge_of_category_without_posts_returns_moved_0_and_still_deletes_source() throws Exception {
        UUID sourceId = idOf(
                data(createCategory(Map.of("name", "Empty Source " + suffix)).andExpect(status().isCreated())));
        UUID targetId = idOf(data(createCategory(Map.of("name", "Empty Receiving Target " + suffix))
                .andExpect(status().isCreated())));

        JsonNode merged = data(mergeCategory(sourceId, targetId).andExpect(status().isOk()));

        assertThat(merged.path("moved").asLong()).isZero();
        assertThat(merged.path("target").path("id").asString()).isEqualTo(targetId.toString());
        assertThat(idsOf(adminList())).doesNotContain(sourceId.toString());
    }

    @Test
    void merge_into_itself_or_bad_body_is_400_missing_target_is_400_missing_source_is_404_and_nothing_changes()
            throws Exception {
        String name = "Kept When Merge Fails " + suffix;
        UUID sourceId = idOf(data(createCategory(Map.of("name", name)).andExpect(status().isCreated())));
        UUID post = createPost("Post kept when the merge fails", sourceId);
        String one = ADMIN_CATEGORIES + "/" + sourceId + "/merge";

        assertError(mergeCategory(sourceId, sourceId), 400, "VALIDATION_ERROR");
        assertError(mergeCategory(sourceId, UUID.randomUUID()), 400, "CATEGORY_NOT_FOUND");
        assertError(postJson(one, "{}"), 400, "VALIDATION_ERROR");
        assertError(postJson(one, "{\"targetId\":\"khong-phai-uuid\"}"), 400, "VALIDATION_ERROR");
        assertError(
                postJson(ADMIN_CATEGORIES + "/khong-phai-uuid/merge", json(Map.of("targetId", sourceId))),
                400,
                "VALIDATION_ERROR");
        // Missing source: 404, even when the target is real.
        assertError(mergeCategory(UUID.randomUUID(), sourceId), 404, "CATEGORY_NOT_FOUND");

        // None of the calls above wrote anything.
        assertThat(findById(adminList(), sourceId).path("name").asString()).isEqualTo(name);
        assertThat(adminPost(post).path("category").path("id").asString()).isEqualTo(sourceId.toString());
    }

    @Test
    void only_admin_can_merge_author_gets_403_no_token_gets_401() throws Exception {
        String author = auth.bearerFor(auth.createAuthor("category-merge-" + suffix + "@blog.local"));
        UUID sourceId = idOf(data(createCategory(Map.of("name", "Merge Permission Source " + suffix))
                .andExpect(status().isCreated())));
        UUID targetId = idOf(data(createCategory(Map.of("name", "Merge Permission Target " + suffix))
                .andExpect(status().isCreated())));
        UUID post = createPost("Post the author does not move", sourceId);
        String body = json(Map.of("targetId", targetId));

        assertError(
                mockMvc.perform(post(ADMIN_CATEGORIES + "/" + sourceId + "/merge")
                        .header("Authorization", author)
                        .contentType(APPLICATION_JSON)
                        .content(body)),
                403,
                "FORBIDDEN");
        assertError(
                mockMvc.perform(post(ADMIN_CATEGORIES + "/" + sourceId + "/merge")
                        .contentType(APPLICATION_JSON)
                        .content(body)),
                401,
                "UNAUTHENTICATED");

        assertThat(idsOf(adminList())).contains(sourceId.toString(), targetId.toString());
        assertThat(adminPost(post).path("category").path("id").asString()).isEqualTo(sourceId.toString());
    }

    // --- Permissions -------------------------------------------------------------------------------

    @Test
    void only_admin_can_edit_and_delete_author_gets_403_no_token_gets_401_while_view_and_create_stay_open_to_author()
            throws Exception {
        String author = auth.bearerFor(auth.createAuthor("category-" + suffix + "@blog.local"));
        String name = "Permission " + suffix;
        UUID id = idOf(data(createCategory(Map.of("name", name)).andExpect(status().isCreated())));
        String one = ADMIN_CATEGORIES + "/" + id;

        // AUTHOR can still view and create: the post editor creates categories in place.
        mockMvc.perform(get(ADMIN_CATEGORIES).header("Authorization", author)).andExpect(status().isOk());
        mockMvc.perform(post(ADMIN_CATEGORIES)
                        .header("Authorization", author)
                        .contentType(APPLICATION_JSON)
                        .content(json(Map.of("name", "Author Own " + suffix))))
                .andExpect(status().isCreated());

        // Renaming or deleting a category touches the posts of every author: AUTHOR gets 403, even for a
        // nonexistent id (the permission is checked before anything is looked up, so no real id can be
        // probed).
        assertError(
                mockMvc.perform(put(one).header("Authorization", author)
                        .contentType(APPLICATION_JSON)
                        .content(json(Map.of("name", "Author Rename " + suffix)))),
                403,
                "FORBIDDEN");
        assertError(mockMvc.perform(delete(one).header("Authorization", author)), 403, "FORBIDDEN");
        assertError(
                mockMvc.perform(
                        delete(ADMIN_CATEGORIES + "/" + UUID.randomUUID()).header("Authorization", author)),
                403,
                "FORBIDDEN");
        assertError(
                mockMvc.perform(
                        put(one).contentType(APPLICATION_JSON).content(json(Map.of("name", "Anonymous " + suffix)))),
                401,
                "UNAUTHENTICATED");
        assertError(mockMvc.perform(delete(one)), 401, "UNAUTHENTICATED");

        // None of the calls above touched the category.
        assertThat(findById(adminList(), id).path("name").asString()).isEqualTo(name);
    }

    // --- Checks ------------------------------------------------------------------------------------

    /** Checks the status and error codes; returns the error body so the message can be checked further. */
    private JsonNode assertError(ResultActions result, int status, String code) throws Exception {
        result.andExpect(status().is(status));
        JsonNode error = objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("error");
        assertThat(error.path("code").asString()).isEqualTo(code);
        return error;
    }

    // --- Reads -------------------------------------------------------------------------------------

    private JsonNode adminList() throws Exception {
        return data(mockMvc.perform(get(ADMIN_CATEGORIES).header("Authorization", admin))
                .andExpect(status().isOk()));
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
        throw new AssertionError("Category not found: " + id + " in the list");
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

    private ResultActions createCategory(Map<String, ?> body) throws Exception {
        return mockMvc.perform(post(ADMIN_CATEGORIES)
                .header("Authorization", admin)
                .contentType(APPLICATION_JSON)
                .content(json(body)));
    }

    private ResultActions updateCategory(UUID id, Map<String, ?> body) throws Exception {
        return putJson(ADMIN_CATEGORIES + "/" + id, json(body));
    }

    private ResultActions putJson(String path, String json) throws Exception {
        return mockMvc.perform(put(path)
                .header("Authorization", admin)
                .contentType(APPLICATION_JSON)
                .content(json));
    }

    private ResultActions deleteCategory(UUID id) throws Exception {
        return mockMvc.perform(delete(ADMIN_CATEGORIES + "/" + id).header("Authorization", admin));
    }

    private ResultActions mergeCategory(UUID sourceId, UUID targetId) throws Exception {
        return postJson(ADMIN_CATEGORIES + "/" + sourceId + "/merge", json(Map.of("targetId", targetId)));
    }

    private ResultActions postJson(String path, String json) throws Exception {
        return mockMvc.perform(post(path)
                .header("Authorization", admin)
                .contentType(APPLICATION_JSON)
                .content(json));
    }

    /** An admin draft; a null {@code categoryId} means no category yet. */
    private UUID createPost(String title, UUID categoryId) throws Exception {
        Map<String, Object> body = new HashMap<>();
        body.put("title", title + " " + suffix);
        body.put("excerpt", "Summary " + suffix);
        body.put("content", String.join(" ", Collections.nCopies(12, "word")));
        body.put("categoryId", categoryId);
        return idOf(data(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(json(body)))
                .andExpect(status().isCreated())));
    }

    private void publish(UUID post) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + post + "/publish").header("Authorization", admin))
                .andExpect(status().isOk());
    }

    /** The full PUT body as the editor sends it, changing only the category. */
    private void movePost(UUID post, UUID categoryId) throws Exception {
        JsonNode before = adminPost(post);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("title", before.path("title").asString());
        body.put("excerpt", before.path("excerpt").asString());
        body.put("content", before.path("content").asString());
        body.put("categoryId", categoryId.toString());
        body.put("tagIds", List.of());
        body.put("slug", before.path("slug").asString());
        putJson("/api/v1/admin/posts/" + post, json(body)).andExpect(status().isOk());
    }

    private static void awaitQuietly(CountDownLatch latch) {
        try {
            latch.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
