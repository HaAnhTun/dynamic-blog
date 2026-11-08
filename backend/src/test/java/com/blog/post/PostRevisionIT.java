package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.post.dto.PostLimits;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.repository.UserRepository;
import java.io.InputStream;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Post revisions: {@code GET /api/v1/admin/posts/{id}/revisions},
 * {@code GET …/revisions/{revisionId}} and {@code POST …/revisions/{revisionId}/restore}.
 *
 * Rules to keep: a save that changes the title, summary or content records the state from BEFORE it, unless a revision
 * newer than 10 minutes exists (consecutive saves merge into one); each post keeps its 20 newest revisions; every other
 * change (slug, category, tags, publish, unpublish, featured, series, cover image) records nothing. Restore first records
 * the current state (no merge, so every restore can be undone) and only then copies the old revision's text into the post;
 * slug, status and classification stay as they are.
 *
 * "10 minutes ago" is built by moving the {@code created_at} of the existing revisions back with SQL, not by waiting.
 *
 * The DB is shared and never cleaned: each test has its own category and post name (random suffix), and only counts the
 * revisions of the post it created.
 */
@AutoConfigureMockMvc
class PostRevisionIT extends AbstractIntegrationTest {

    private static final String POSTS = "/api/v1/admin/posts/";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private UserRepository userRepository;

    private String admin;
    private String suffix;
    private UUID categoryId;

    @BeforeEach
    void setUp() throws Exception {
        admin = auth.bearerForAdmin();
        suffix = UUID.randomUUID().toString().substring(0, 8);
        categoryId = createCategory("Category revisions " + suffix);
    }

    // --- Recording a revision when the text changes ------------------------------------------------

    @Test
    void editing_content_records_previous_state_as_a_fully_readable_revision() throws Exception {
        UUID postId = createPost(admin, "Post with history", null, "First version " + suffix);
        assertThat(revisions(admin, postId)).isEmpty();

        save(admin, postId, edit(postId).content("Second version " + suffix));

        JsonNode listed = data(list(admin, postId).andExpect(status().isOk()));
        assertThat(listed).hasSize(1);
        JsonNode summary = listed.get(0);
        // The list carries no content: only id, title and time of recording.
        assertThat(summary.propertyNames()).containsExactlyInAnyOrder("id", "title", "createdAt");
        assertThat(summary.path("title").asString()).isEqualTo("Post with history " + suffix);
        Instant createdAt = Instant.parse(summary.path("createdAt").asString());
        assertThat(createdAt)
                .isBefore(Instant.now().plusSeconds(5))
                .isAfter(Instant.now().minusSeconds(120));

        JsonNode revision = data(detail(admin, postId, id(summary)).andExpect(status().isOk()));
        assertThat(revision.propertyNames())
                .containsExactlyInAnyOrder("id", "title", "excerpt", "content", "createdAt");
        assertThat(revision.path("id").asString()).isEqualTo(id(summary).toString());
        // The state from BEFORE the save, including an empty summary (null, not an empty string).
        assertThat(revision.path("title").asString()).isEqualTo("Post with history " + suffix);
        assertThat(revision.path("excerpt").isNull()).isTrue();
        assertThat(revision.path("content").asString()).isEqualTo("First version " + suffix);
        assertThat(Instant.parse(revision.path("createdAt").asString())).isEqualTo(createdAt);
        // The recorder is the user who saved that change, taken from the token.
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT created_by FROM post_revisions WHERE id = ?", UUID.class, id(summary)))
                .isEqualTo(adminId());
        // The post carries the new version.
        assertThat(adminDetail(postId).path("content").asString()).isEqualTo("Second version " + suffix);
    }

    @Test
    void changing_title_or_summary_also_records_a_revision() throws Exception {
        UUID titled = createPost(admin, "Old title", "Summary kept " + suffix, "Content kept");
        UUID summarised = createPost(admin, "Post with a changed summary", "Old summary " + suffix, "Content kept");

        save(admin, titled, edit(titled).title("New title " + suffix));
        save(admin, summarised, edit(summarised).excerpt("New summary " + suffix));

        assertThat(revisionTitles(titled)).containsExactly("Old title " + suffix);
        assertThat(data(detail(
                                admin,
                                summarised,
                                id(revisions(admin, summarised).get(0))))
                        .path("excerpt")
                        .asString())
                .isEqualTo("Old summary " + suffix);
    }

    @Test
    void slug_category_tags_publish_unpublish_featured_series_and_cover_record_no_revision() throws Exception {
        UUID postId = createPost(
                admin, "Post changing only what is outside the text", "Summary " + suffix, "Content " + suffix);
        UUID tag = createTag("Tag with no version " + suffix);
        UUID otherCategory = createCategory("Other category with no version " + suffix);

        // A full PUT as the editor sends it, text unchanged: only tags, category and slug change.
        save(admin, postId, edit(postId).tags(List.of(tag)));
        save(admin, postId, edit(postId).category(otherCategory));
        save(admin, postId, edit(postId).slug("slug-moi-khong-ghi-ban-" + suffix));
        // Saved again exactly as is (clicking Save when nothing changed).
        save(admin, postId, edit(postId));
        for (String action : List.of("publish", "feature", "unfeature", "unpublish")) {
            mockMvc.perform(post(POSTS + postId + "/" + action).header("Authorization", admin))
                    .andExpect(status().isOk());
        }
        UUID series = UUID.fromString(data(mockMvc.perform(post("/api/v1/admin/series")
                                .header("Authorization", admin)
                                .contentType(APPLICATION_JSON)
                                .content(json(Map.of("title", "Series with no version " + suffix))))
                        .andExpect(status().isCreated()))
                .path("id")
                .asString());
        mockMvc.perform(put("/api/v1/admin/series/" + series + "/posts")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(json(Map.of("postIds", List.of(postId)))))
                .andExpect(status().isOk());
        mockMvc.perform(multipart(POSTS + postId + "/cover")
                        .file(new MockMultipartFile("file", "opaque.png", "image/png", fixture("opaque.png")))
                        .header("Authorization", admin))
                .andExpect(status().isOk());

        assertThat(revisions(admin, postId)).isEmpty();
        // Control: the calls above took effect, and a text change does record a revision.
        JsonNode current = adminDetail(postId);
        assertThat(current.path("slug").asString()).isEqualTo("slug-moi-khong-ghi-ban-" + suffix);
        assertThat(current.path("category").path("id").asString()).isEqualTo(otherCategory.toString());
        assertThat(current.path("series").path("id").asString()).isEqualTo(series.toString());
        save(admin, postId, edit(postId).content("Now changed text " + suffix));
        assertThat(revisions(admin, postId)).hasSize(1);
    }

    @Test
    void rejected_save_leaves_no_revision() throws Exception {
        UUID postId = createPost(admin, "Post with a failed save", null, "Content " + suffix);

        // The text changes but the category does not exist: the whole save rolls back, including the revision just
        // recorded.
        Map<String, Object> body = edit(postId)
                .content("Content that is never saved")
                .category(UUID.randomUUID())
                .body();
        assertError(
                mockMvc.perform(put(POSTS + postId)
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(json(body))),
                400,
                "CATEGORY_NOT_FOUND");

        assertThat(revisions(admin, postId)).isEmpty();
        assertThat(adminDetail(postId).path("content").asString()).isEqualTo("Content " + suffix);
    }

    // --- Merging saves within 10 minutes, keeping 20 revisions ------------------------------------

    @Test
    void saves_within_10_minutes_merge_into_one_revision_and_save_after_10_minutes_records_a_new_one()
            throws Exception {
        UUID postId = createPost(admin, "Post saved continuously", null, "S0 " + suffix);

        save(admin, postId, edit(postId).content("S1 " + suffix));
        save(admin, postId, edit(postId).content("S2 " + suffix));
        // Two consecutive saves: one revision, and it is the state before the FIRST save (S0), not S1.
        assertThat(revisionContents(postId)).containsExactly("S0 " + suffix);

        // 9 minutes after the latest revision: still inside the window, still merged.
        ageRevisions(postId, 9);
        save(admin, postId, edit(postId).content("S3 " + suffix));
        assertThat(revisionContents(postId)).containsExactly("S0 " + suffix);

        // Another 2 minutes (11 minutes): the next save records the state right before it (S3), newest first.
        ageRevisions(postId, 2);
        save(admin, postId, edit(postId).content("S4 " + suffix));
        assertThat(revisionContents(postId)).containsExactly("S3 " + suffix, "S0 " + suffix);
        assertThat(adminDetail(postId).path("content").asString()).isEqualTo("S4 " + suffix);
    }

    @Test
    void each_post_keeps_20_newest_revisions_older_ones_dropped_and_other_posts_untouched() throws Exception {
        UUID postId = createPost(admin, "Post edited very many times", null, "S0 " + suffix);
        UUID neighbour = createPost(admin, "Neighbor post", null, "Neighbor 0 " + suffix);
        save(admin, neighbour, edit(neighbour).content("Neighbor 1 " + suffix));

        for (int i = 1; i <= 22; i++) {
            ageRevisions(postId, 11);
            save(admin, postId, edit(postId).content("S" + i + " " + suffix));
        }

        // 22 recordings (S0..S21), keeping the 20 newest: S21 down to S2, while S1 and S0 were dropped.
        List<String> expected = new ArrayList<>();
        for (int i = 21; i >= 2; i--) {
            expected.add("S" + i + " " + suffix);
        }
        assertThat(revisionContents(postId)).containsExactlyElementsOf(expected);
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM post_revisions WHERE post_id = ?", Long.class, postId))
                .isEqualTo(20);
        assertThat(revisionContents(neighbour)).containsExactly("Neighbor 0 " + suffix);
    }

    // --- Restore -----------------------------------------------------------------------------------

    @Test
    void restore_copies_old_text_keeps_slug_status_classification_and_records_current_state_for_undo()
            throws Exception {
        UUID tag = createTag("Restore tag " + suffix);
        UUID postId = createPost(admin, "Title S0", null, "Content S0 " + suffix);
        save(
                admin,
                postId,
                edit(postId)
                        .title("Title S1 " + suffix)
                        .excerpt("Summary S1 " + suffix)
                        .content("Content S1 " + suffix)
                        .tags(List.of(tag))
                        .slug("slug-khoi-phuc-" + suffix));
        mockMvc.perform(post(POSTS + postId + "/publish").header("Authorization", admin))
                .andExpect(status().isOk());
        UUID s0 = id(revisions(admin, postId).get(0));
        JsonNode before = adminDetail(postId);

        JsonNode restored = data(restore(admin, postId, s0).andExpect(status().isOk()));

        // The response is the post itself (PostResponse), carrying S0's text and an empty summary like S0.
        assertThat(restored.path("id").asString()).isEqualTo(postId.toString());
        assertThat(restored.path("title").asString()).isEqualTo("Title S0 " + suffix);
        assertThat(restored.path("excerpt").isNull()).isTrue();
        assertThat(restored.path("content").asString()).isEqualTo("Content S0 " + suffix);
        // Slug, status, publish date, category and tags stay as they are.
        for (String field : List.of("slug", "status", "publishedAt", "category", "tags")) {
            assertThat(restored.path(field)).as(field).isEqualTo(before.path(field));
        }
        JsonNode reread = adminDetail(postId);
        assertThat(reread.path("content").asString()).isEqualTo("Content S0 " + suffix);
        // A restore is a post edit: updatedAt jumps, both on the stored post and in the response itself (not the old
        // value
        // still in memory before the write to the DB).
        Instant updatedBefore = Instant.parse(before.path("updatedAt").asString());
        assertThat(Instant.parse(reread.path("updatedAt").asString())).isAfter(updatedBefore);
        assertThat(Instant.parse(restored.path("updatedAt").asString())).isAfter(updatedBefore);

        // The state right before the restore (S1) was recorded even though the latest revision is seconds old: no
        // merge.
        List<JsonNode> history = revisions(admin, postId);
        assertThat(history).hasSize(2);
        JsonNode undo = data(detail(admin, postId, id(history.get(0))).andExpect(status().isOk()));
        assertThat(undo.path("title").asString()).isEqualTo("Title S1 " + suffix);
        assertThat(undo.path("excerpt").asString()).isEqualTo("Summary S1 " + suffix);
        assertThat(undo.path("content").asString()).isEqualTo("Content S1 " + suffix);
        assertThat(id(history.get(1))).isEqualTo(s0);

        // Undo: restoring the revision just recorded puts the post back to S1, and records S0 beforehand again.
        JsonNode undone = data(restore(admin, postId, id(undo)).andExpect(status().isOk()));
        assertThat(undone.path("title").asString()).isEqualTo("Title S1 " + suffix);
        assertThat(undone.path("excerpt").asString()).isEqualTo("Summary S1 " + suffix);
        assertThat(undone.path("content").asString()).isEqualTo("Content S1 " + suffix);
        assertThat(revisionContents(postId))
                .containsExactly("Content S0 " + suffix, "Content S1 " + suffix, "Content S0 " + suffix);
        assertThat(adminDetail(postId).path("status").asString()).isEqualTo("PUBLISHED");
    }

    @Test
    void restoring_revision_identical_to_post_changes_nothing_and_records_no_revision() throws Exception {
        UUID postId = createPost(admin, "Post restored twice", null, "Content A " + suffix);
        save(admin, postId, edit(postId).content("Content B " + suffix));
        UUID a = id(revisions(admin, postId).get(0));
        data(restore(admin, postId, a).andExpect(status().isOk()));
        JsonNode before = adminDetail(postId);
        int count = revisions(admin, postId).size();

        // The post already has revision A's text: clicking restore again records nothing.
        JsonNode again = data(restore(admin, postId, a).andExpect(status().isOk()));

        assertThat(again.path("content").asString()).isEqualTo("Content A " + suffix);
        assertThat(revisions(admin, postId)).hasSize(count);
        assertThat(adminDetail(postId).path("updatedAt").asString())
                .isEqualTo(before.path("updatedAt").asString());
    }

    @Test
    void restoring_a_revision_longer_than_a_post_may_be_is_a_clean_400_and_changes_nothing() throws Exception {
        // Issue 013: a revision saved before the size limits can be longer than the database now lets a post be (V46).
        // The
        // revision table has no limit of its own, so the oversized row can exist; restoring it must not end in a
        // conflict.
        UUID postId = createPost(admin, "Post with an old long revision", null, "Current content " + suffix);
        UUID tooLongContent = UUID.randomUUID();
        UUID tooLongExcerpt = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO post_revisions (id, post_id, title, excerpt, content, created_by) "
                        + "VALUES (?, ?, 'Old title', NULL, repeat('x', ?), ?)",
                tooLongContent,
                postId,
                PostLimits.CONTENT_MAX + 1,
                adminId());
        jdbcTemplate.update(
                "INSERT INTO post_revisions (id, post_id, title, excerpt, content, created_by) "
                        + "VALUES (?, ?, 'Old title', repeat('e', ?), 'Short content', ?)",
                tooLongExcerpt,
                postId,
                PostLimits.EXCERPT_MAX + 1,
                adminId());

        assertError(restore(admin, postId, tooLongContent), 400, "VALIDATION_ERROR");
        assertError(restore(admin, postId, tooLongExcerpt), 400, "VALIDATION_ERROR");

        // Nothing was written: the post is as it was and no revision of the current state was added.
        assertThat(adminDetail(postId).path("content").asString()).isEqualTo("Current content " + suffix);
        assertThat(revisions(admin, postId)).hasSize(2);
    }

    @Test
    void revision_of_other_post_or_missing_is_404_REVISION_NOT_FOUND_and_missing_post_is_404_POST_NOT_FOUND()
            throws Exception {
        UUID postId = createPost(admin, "Post with its own versions", null, "Own content " + suffix);
        UUID other = createPost(admin, "Other post with its own versions", null, "Other content " + suffix);
        save(admin, other, edit(other).content("Other content edited " + suffix));
        UUID othersRevision = id(revisions(admin, other).get(0));

        assertError(detail(admin, postId, othersRevision), 404, "REVISION_NOT_FOUND");
        assertError(restore(admin, postId, othersRevision), 404, "REVISION_NOT_FOUND");
        assertError(detail(admin, postId, UUID.randomUUID()), 404, "REVISION_NOT_FOUND");
        assertError(restore(admin, postId, UUID.randomUUID()), 404, "REVISION_NOT_FOUND");
        assertError(
                mockMvc.perform(
                        get(POSTS + postId + "/revisions/khong-phai-uuid").header("Authorization", admin)),
                400,
                "VALIDATION_ERROR");

        UUID ghost = UUID.randomUUID();
        assertError(list(admin, ghost), 404, "POST_NOT_FOUND");
        assertError(detail(admin, ghost, othersRevision), 404, "POST_NOT_FOUND");
        assertError(restore(admin, ghost, othersRevision), 404, "POST_NOT_FOUND");

        // None of the calls above touched any post.
        assertThat(adminDetail(postId).path("content").asString()).isEqualTo("Own content " + suffix);
        assertThat(adminDetail(other).path("content").asString()).isEqualTo("Other content edited " + suffix);
        assertThat(revisions(admin, postId)).isEmpty();
    }

    @Test
    void deleting_post_deletes_its_revisions() throws Exception {
        UUID postId = createPost(admin, "Post deleted with its history", null, "S0 " + suffix);
        save(admin, postId, edit(postId).content("S1 " + suffix));
        ageRevisions(postId, 11);
        save(admin, postId, edit(postId).content("S2 " + suffix));
        assertThat(revisionCount(postId)).isEqualTo(2);

        mockMvc.perform(delete(POSTS + postId).header("Authorization", admin)).andExpect(status().isNoContent());

        assertThat(revisionCount(postId)).isZero();
    }

    // --- Permissions: permission on the history is permission on the post ---------------------------

    @Test
    void author_can_read_and_restore_own_post_other_authors_post_is_403_and_anonymous_is_401() throws Exception {
        User alice = auth.createAuthor("alice-revisions-" + UUID.randomUUID() + "@blog.local");
        User bob = auth.createAuthor("bob-revisions-" + UUID.randomUUID() + "@blog.local");
        String aliceToken = auth.bearerFor(alice);
        String bobToken = auth.bearerFor(bob);
        UUID alicePost = createPost(aliceToken, "Alice post with history", null, "Alice S0 " + suffix);
        UUID bobPost = createPost(bobToken, "Bob post with history", null, "Bob S0 " + suffix);
        save(aliceToken, alicePost, edit(aliceToken, alicePost).content("Alice S1 " + suffix));
        save(bobToken, bobPost, edit(bobToken, bobPost).content("Bob S1 " + suffix));
        UUID aliceRevision = id(revisions(aliceToken, alicePost).get(0));
        UUID bobRevision = id(revisions(bobToken, bobPost).get(0));

        // Own post: can read and restore; the revision records Alice's name.
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT created_by FROM post_revisions WHERE id = ?", UUID.class, aliceRevision))
                .isEqualTo(alice.getId());
        assertThat(data(detail(aliceToken, alicePost, aliceRevision).andExpect(status().isOk()))
                        .path("content")
                        .asString())
                .isEqualTo("Alice S0 " + suffix);
        assertThat(data(restore(aliceToken, alicePost, aliceRevision).andExpect(status().isOk()))
                        .path("content")
                        .asString())
                .isEqualTo("Alice S0 " + suffix);

        // Bob's post: all three are 403. Naming own post with Bob's revision: that revision does not belong to this
        // post, 404.
        assertError(list(aliceToken, bobPost), 403, "FORBIDDEN");
        assertError(detail(aliceToken, bobPost, bobRevision), 403, "FORBIDDEN");
        assertError(restore(aliceToken, bobPost, bobRevision), 403, "FORBIDDEN");
        assertError(detail(aliceToken, alicePost, bobRevision), 404, "REVISION_NOT_FOUND");
        assertError(restore(aliceToken, alicePost, bobRevision), 404, "REVISION_NOT_FOUND");

        // Anonymous: 401 on all three.
        assertError(mockMvc.perform(get(POSTS + bobPost + "/revisions")), 401, "UNAUTHENTICATED");
        assertError(mockMvc.perform(get(POSTS + bobPost + "/revisions/" + bobRevision)), 401, "UNAUTHENTICATED");
        assertError(
                mockMvc.perform(post(POSTS + bobPost + "/revisions/" + bobRevision + "/restore")),
                401,
                "UNAUTHENTICATED");

        // Bob's post is intact, and so is its history.
        assertThat(adminDetail(bobPost).path("content").asString()).isEqualTo("Bob S1 " + suffix);
        assertThat(revisions(bobToken, bobPost)).hasSize(1);
    }

    // --- Helpers -----------------------------------------------------------------------------------

    /** A full PUT body as the editor sends it, built from the current post; each function changes exactly one field. */
    private final class Edit {

        private final Map<String, Object> body = new HashMap<>();

        Edit(JsonNode current) {
            body.put("title", current.path("title").asString());
            body.put(
                    "excerpt",
                    current.path("excerpt").isNull()
                            ? null
                            : current.path("excerpt").asString());
            body.put("content", current.path("content").asString());
            body.put(
                    "categoryId",
                    current.path("category").isNull()
                            ? null
                            : current.path("category").path("id").asString());
            List<String> tags = new ArrayList<>();
            current.path("tags").forEach(tag -> tags.add(tag.path("id").asString()));
            body.put("tagIds", tags);
            body.put("slug", current.path("slug").asString());
        }

        Edit title(String title) {
            body.put("title", title);
            return this;
        }

        Edit excerpt(String excerpt) {
            body.put("excerpt", excerpt);
            return this;
        }

        Edit content(String content) {
            body.put("content", content);
            return this;
        }

        Edit category(UUID category) {
            body.put("categoryId", category.toString());
            return this;
        }

        Edit tags(List<UUID> tags) {
            body.put("tagIds", tags.stream().map(UUID::toString).toList());
            return this;
        }

        Edit slug(String slug) {
            body.put("slug", slug);
            return this;
        }

        Map<String, Object> body() {
            return body;
        }
    }

    private Edit edit(UUID postId) throws Exception {
        return edit(admin, postId);
    }

    private Edit edit(String token, UUID postId) throws Exception {
        return new Edit(data(mockMvc.perform(get(POSTS + postId).header("Authorization", token))
                .andExpect(status().isOk())));
    }

    private void save(String token, UUID postId, Edit edit) throws Exception {
        MockHttpServletResponse response = mockMvc.perform(put(POSTS + postId)
                        .header("Authorization", token)
                        .contentType(APPLICATION_JSON)
                        .content(json(edit.body())))
                .andReturn()
                .getResponse();
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
    }

    private ResultActions list(String token, UUID postId) throws Exception {
        return mockMvc.perform(get(POSTS + postId + "/revisions").header("Authorization", token));
    }

    private ResultActions detail(String token, UUID postId, UUID revisionId) throws Exception {
        return mockMvc.perform(get(POSTS + postId + "/revisions/" + revisionId).header("Authorization", token));
    }

    private ResultActions restore(String token, UUID postId, UUID revisionId) throws Exception {
        return mockMvc.perform(
                post(POSTS + postId + "/revisions/" + revisionId + "/restore").header("Authorization", token));
    }

    /** The list of revisions, newest first; fails if not 200. */
    private List<JsonNode> revisions(String token, UUID postId) throws Exception {
        List<JsonNode> revisions = new ArrayList<>();
        data(list(token, postId).andExpect(status().isOk())).forEach(revisions::add);
        return revisions;
    }

    private List<String> revisionTitles(UUID postId) throws Exception {
        return revisions(admin, postId).stream()
                .map(revision -> revision.path("title").asString())
                .toList();
    }

    /** The content of each revision, in list order: each revision is read through the detail endpoint. */
    private List<String> revisionContents(UUID postId) throws Exception {
        List<String> contents = new ArrayList<>();
        for (JsonNode revision : revisions(admin, postId)) {
            contents.add(data(detail(admin, postId, id(revision)).andExpect(status().isOk()))
                    .path("content")
                    .asString());
        }
        return contents;
    }

    private long revisionCount(UUID postId) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM post_revisions WHERE post_id = ?", Long.class, postId);
    }

    /** Moves every revision of the post back by {@code minutes} minutes: as if the latest recording happened that much longer ago. */
    private void ageRevisions(UUID postId, int minutes) {
        jdbcTemplate.update(
                "UPDATE post_revisions SET created_at = created_at - make_interval(mins => ?) " + "WHERE post_id = ?",
                minutes,
                postId);
    }

    private UUID createPost(String token, String title, String excerpt, String content) throws Exception {
        Map<String, Object> body = new HashMap<>();
        body.put("title", title + " " + suffix);
        body.put("excerpt", excerpt);
        body.put("content", content);
        body.put("categoryId", categoryId.toString());
        return UUID.fromString(data(mockMvc.perform(post("/api/v1/admin/posts")
                                .header("Authorization", token)
                                .contentType(APPLICATION_JSON)
                                .content(json(body)))
                        .andExpect(status().isCreated()))
                .path("id")
                .asString());
    }

    private UUID createCategory(String name) throws Exception {
        return UUID.fromString(data(mockMvc.perform(post("/api/v1/admin/categories")
                                .header("Authorization", admin)
                                .contentType(APPLICATION_JSON)
                                .content(json(Map.of("name", name))))
                        .andExpect(status().isCreated()))
                .path("id")
                .asString());
    }

    private UUID createTag(String name) throws Exception {
        return UUID.fromString(data(mockMvc.perform(post("/api/v1/admin/tags")
                                .header("Authorization", admin)
                                .contentType(APPLICATION_JSON)
                                .content(json(Map.of("name", name))))
                        .andExpect(status().isCreated()))
                .path("id")
                .asString());
    }

    private JsonNode adminDetail(UUID postId) throws Exception {
        return data(mockMvc.perform(get(POSTS + postId).header("Authorization", admin))
                .andExpect(status().isOk()));
    }

    private UUID adminId() {
        return userRepository.findByEmail("admin@blog.local").orElseThrow().getId();
    }

    private void assertError(ResultActions result, int status, String code) throws Exception {
        MockHttpServletResponse response = result.andReturn().getResponse();
        String body = response.getContentAsString();
        assertThat(response.getStatus()).as(body).isEqualTo(status);
        assertThat(objectMapper.readTree(body).path("error").path("code").asString())
                .as(body)
                .isEqualTo(code);
    }

    private static UUID id(JsonNode node) {
        return UUID.fromString(node.path("id").asString());
    }

    private static byte[] fixture(String name) throws Exception {
        try (InputStream in = PostRevisionIT.class.getResourceAsStream("/media/" + name)) {
            assertThat(in).as("fixture %s", name).isNotNull();
            return in.readAllBytes();
        }
    }

    private String json(Object body) {
        return objectMapper.writeValueAsString(body);
    }

    private JsonNode data(ResultActions result) throws Exception {
        return objectMapper
                .readTree(result.andReturn().getResponse().getContentAsString())
                .path("data");
    }
}
