package com.blog.comment;

import static com.blog.comment.CommentFixtures.replyIds;
import static com.blog.comment.CommentFixtures.rootIds;
import static com.blog.comment.CommentFixtures.thread;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.common.security.SeedAdmin;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import jakarta.persistence.EntityManagerFactory;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Public comments and the caller own comments: {@code GET/POST /api/v1/posts/{slug}/comments},
 * {@code POST /api/v1/comments/{id}/replies}, {@code PUT/DELETE /api/v1/comments/{id}}.
 *
 * Every token belongs to a reader created just for each test (rate limit per person, in the memory of the
 * shared context); each person creates at most 5 in a test. Public reads carry no Authorization header. The
 * rate limit and the duplicate-submission guard have their own IT (CommentRateLimitIT), and so do the write
 * races (CommentConcurrencyIT).
 */
@AutoConfigureMockMvc
class CommentIT extends AbstractIntegrationTest {

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

    private static String cp(int... codePoints) {
        return new String(codePoints, 0, codePoints.length);
    }

    // --- Create, read, reply ---------------------------------------------------------------------------

    @Test
    void create_root_comment_and_reply_then_read_back_by_thread() throws Exception {
        Post post = f.publishedPost("Basic comments");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");

        // Content is sanitized before saving: CRLF becomes LF, surrounding whitespace and bidi override
        // characters are dropped.
        JsonNode created =
                f.data(f.create(an, post, "  Great post" + cp(0x202E) + " indeed!\r\nThanks to the author.  ")
                        .andExpect(status().isCreated()));
        String stored = "Great post indeed!\nThanks to the author.";
        assertThat(created.propertyNames())
                .containsExactlyInAnyOrder(
                        "id",
                        "status",
                        "content",
                        "author",
                        "createdAt",
                        "edited",
                        "mine",
                        "editedAt",
                        "likeCount",
                        "likedByMe");
        assertThat(created.path("status").asString()).isEqualTo("VISIBLE");
        assertThat(created.path("content").asString()).isEqualTo(stored);
        // siteOwner is added at the end, plus a public handle; still no id, email or role.
        assertThat(created.path("author").propertyNames())
                .containsExactlyInAnyOrder("displayName", "githubLogin", "avatarUrl", "siteOwner", "profileSlug");
        assertThat(created.path("author").path("profileSlug").asString())
                .isEqualTo(jdbcTemplate.queryForObject(
                        "SELECT public_slug FROM users WHERE id = ?", String.class, an.id()));
        assertThat(created.path("author").path("displayName").asString()).isEqualTo(an.displayName());
        assertThat(created.path("author").path("githubLogin").asString()).isEqualTo(an.login());
        assertThat(created.path("author").path("avatarUrl").asString())
                .startsWith("https://avatars.githubusercontent.com/u/");
        assertThat(created.path("author").path("siteOwner").isBoolean()).isTrue();
        assertThat(created.path("author").path("siteOwner").asBoolean()).isFalse();
        assertThat(created.path("edited").asBoolean()).isFalse();
        assertThat(created.path("mine").asBoolean()).isTrue();
        // Not edited, nobody has liked it.
        assertThat(created.path("editedAt").isNull()).isTrue();
        assertThat(created.path("likeCount").asLong()).isZero();
        assertThat(created.path("likedByMe").asBoolean()).isFalse();
        UUID rootId = UUID.fromString(created.path("id").asString());
        Instant createdAt = Instant.parse(created.path("createdAt").asString());

        // The writer is the token owner, the post comes from the path.
        Map<String, Object> row = f.row(rootId);
        assertThat(row.get("user_id")).isEqualTo(an.id());
        assertThat(row.get("parent_id")).isNull();
        assertThat(row.get("content")).isEqualTo(stored);
        assertThat(row.get("status")).isEqualTo("VISIBLE");
        assertThat(row.get("edited_at")).isNull();
        assertThat(f.countComments("id = ? AND post_id = ?", rootId, post.id())).isEqualTo(1);

        UUID first = f.createdId(f.reply(binh, rootId, "I agree with you"));
        UUID second = f.createdId(f.reply(an, rootId, "Thanks for reading"));
        assertThat(f.row(first).get("parent_id")).isEqualTo(rootId);
        assertThat(f.countComments("id = ? AND post_id = ?", first, post.id())).isEqualTo(1);

        JsonNode page = f.page(post);
        assertThat(rootIds(page)).containsExactly(rootId);
        assertThat(page.path("nextCursor").isNull()).isTrue();
        JsonNode thread = thread(page, rootId);
        assertThat(thread.path("comment").path("content").asString()).isEqualTo(stored);
        // Read time equals creation time to the microsecond: the keyset cursor relies on it.
        assertThat(Instant.parse(thread.path("comment").path("createdAt").asString()))
                .isEqualTo(createdAt);
        // Older replies first.
        assertThat(replyIds(thread)).containsExactly(first, second);
        assertThat(thread.path("replies")
                        .get(0)
                        .path("author")
                        .path("displayName")
                        .asString())
                .isEqualTo(binh.displayName());
    }

    @Test
    void mine_is_true_only_for_the_writer_and_always_false_for_anonymous() throws Exception {
        Post post = f.publishedPost("Whose comment");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID anRoot = f.createdId(f.create(an, post, "Comment by An"));
        UUID binhReply = f.createdId(f.reply(binh, anRoot, "Reply by Ben"));

        Map<String, Map<UUID, Boolean>> expected = new LinkedHashMap<>();
        expected.put("anonymous", Map.of(anRoot, false, binhReply, false));
        expected.put("An", Map.of(anRoot, true, binhReply, false));
        expected.put("Ben", Map.of(anRoot, false, binhReply, true));
        Map<String, String> bearers = new HashMap<>();
        bearers.put("An", an.bearer());
        bearers.put("Ben", binh.bearer());

        for (Map.Entry<String, Map<UUID, Boolean>> viewer : expected.entrySet()) {
            ResultActions result = f.list(post, bearers.get(viewer.getKey())).andExpect(status().isOk());
            JsonNode thread = thread(f.data(result), anRoot);
            assertThat(thread.path("comment").path("mine").asBoolean())
                    .as("%s: root", viewer.getKey())
                    .isEqualTo(viewer.getValue().get(anRoot));
            assertThat(thread.path("replies").get(0).path("mine").asBoolean())
                    .as("%s: reply", viewer.getKey())
                    .isEqualTo(viewer.getValue().get(binhReply));
            // The response never carries a user id: "mine" is computed on the server.
            assertThat(result.andReturn().getResponse().getContentAsString())
                    .doesNotContain(an.id().toString())
                    .doesNotContain(binh.id().toString());
        }

        // A user who is not logged in cannot write anything.
        f.assertError(f.create(null, post, "Anonymous comment"), 401, "UNAUTHENTICATED");
        assertThat(f.countComments("post_id = ?", post.id())).isEqualTo(2);
    }

    @Test
    void password_only_account_can_comment_and_does_not_leak_email() throws Exception {
        Post post = f.publishedPost("Author comments");
        String email = "comment-author-" + f.suffix + "@blog.local";
        User author = auth.createAccount(email, UserRole.AUTHOR);
        // The fixture default name contains an email; the real CMS name does not.
        String displayName = "Author " + f.suffix;
        jdbcTemplate.update("UPDATE users SET display_name = ? WHERE id = ?", displayName, author.getId());
        Reader writer = new Reader(author.getId(), auth.bearerFor(author), null, displayName);

        ResultActions created = f.create(writer, post, "Thanks everyone for reading");
        JsonNode comment = f.data(created.andExpect(status().isCreated()));

        assertThat(comment.path("author").path("displayName").asString()).isEqualTo(displayName);
        assertThat(comment.path("author").path("githubLogin").isNull()).isTrue();
        assertThat(comment.path("author").path("avatarUrl").isNull()).isTrue();
        assertThat(created.andReturn().getResponse().getContentAsString()).doesNotContain(email);
        assertThat(f.list(post, null).andReturn().getResponse().getContentAsString())
                .doesNotContain(email)
                .doesNotContain(author.getId().toString())
                .doesNotContain("AUTHOR");
    }

    @Test
    void site_owner_is_true_only_for_seeded_admin_row_not_other_admin_or_reader_with_same_name() throws Exception {
        Post post = f.publishedPost("Blog owner badge");
        // The site owner is the seeded row, not the ADMIN role. The two comments below are the only
        // time any IT spends the comment rate limit of the seeded row; its name is read from the DB, not
        // reset, because the seeded row is shared.
        String ownerName =
                jdbcTemplate.queryForObject("SELECT display_name FROM users WHERE id = ?", String.class, SeedAdmin.ID);
        Reader owner = new Reader(SeedAdmin.ID, auth.bearerForAdmin(), null, ownerName);
        // A second ADMIN with the same name: being granted the ADMIN role does not make anyone the "Blog owner".
        User second = auth.createAccount("admin-thu-hai-" + f.suffix + "@blog.local", UserRole.ADMIN);
        jdbcTemplate.update("UPDATE users SET display_name = ? WHERE id = ?", ownerName, second.getId());
        Reader otherAdmin = new Reader(second.getId(), auth.bearerFor(second), null, ownerName);
        Reader author = f.author("nhan-tac-gia");
        // A reader who sets a GitHub name equal to the site owner name (reader names follow GitHub): the name
        // cannot tell the two apart.
        Reader impostor = f.reader("nhan-gia-danh");
        jdbcTemplate.update("UPDATE users SET display_name = ? WHERE id = ?", ownerName, impostor.id());

        JsonNode created =
                f.data(f.create(owner, post, "Thanks everyone for stopping by").andExpect(status().isCreated()));
        assertThat(created.path("author").path("siteOwner").isBoolean()).isTrue();
        assertThat(created.path("author").path("siteOwner").asBoolean()).isTrue();
        UUID ownerRoot = UUID.fromString(created.path("id").asString());
        JsonNode byOtherAdmin =
                f.data(f.create(otherAdmin, post, "I also administer this blog").andExpect(status().isCreated()));
        assertThat(byOtherAdmin.path("author").path("siteOwner").asBoolean()).isFalse();
        UUID otherAdminRoot = UUID.fromString(byOtherAdmin.path("id").asString());
        UUID impostorRoot = f.createdId(f.create(impostor, post, "I am the real blog owner"));
        UUID authorRoot = f.createdId(f.create(author, post, "Guest author gives feedback"));
        JsonNode reply =
                f.data(f.reply(owner, impostorRoot, "Not really, friend").andExpect(status().isCreated()));
        assertThat(reply.path("author").path("siteOwner").asBoolean()).isTrue();

        // Public page, read as a user not logged in: three people with the same name, only the seeded row
        // comment carries the flag. The second ADMIN and the AUTHOR are not the site owner.
        JsonNode page = f.page(post);
        assertThat(thread(page, ownerRoot)
                        .path("comment")
                        .path("author")
                        .path("siteOwner")
                        .asBoolean())
                .isTrue();
        JsonNode otherAdminThread = thread(page, otherAdminRoot);
        assertThat(otherAdminThread
                        .path("comment")
                        .path("author")
                        .path("displayName")
                        .asString())
                .isEqualTo(ownerName);
        assertThat(otherAdminThread
                        .path("comment")
                        .path("author")
                        .path("siteOwner")
                        .asBoolean())
                .isFalse();
        JsonNode impostorThread = thread(page, impostorRoot);
        assertThat(impostorThread
                        .path("comment")
                        .path("author")
                        .path("displayName")
                        .asString())
                .isEqualTo(ownerName);
        assertThat(impostorThread
                        .path("comment")
                        .path("author")
                        .path("siteOwner")
                        .asBoolean())
                .isFalse();
        assertThat(impostorThread
                        .path("replies")
                        .get(0)
                        .path("author")
                        .path("siteOwner")
                        .asBoolean())
                .isTrue();
        assertThat(thread(page, authorRoot)
                        .path("comment")
                        .path("author")
                        .path("siteOwner")
                        .asBoolean())
                .isFalse();
        // No role name, no role field in the response.
        assertThat(f.list(post, null).andReturn().getResponse().getContentAsString())
                .doesNotContain("ADMIN")
                .doesNotContain("AUTHOR")
                .doesNotContain("\"role\"");
    }

    // --- One-level replies -----------------------------------------------------------------------------

    @Test
    void reply_to_a_reply_is_422_while_hidden_deleted_or_missing_parent_is_404() throws Exception {
        Post post = f.publishedPost("One-level reply");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        Reader chi = f.reader("chi");
        UUID root = f.createdId(f.create(an, post, "Root comment"));
        UUID reply = f.createdId(f.reply(binh, root, "One reply"));
        Instant earlier = Instant.now().minusSeconds(60);
        UUID hiddenRoot = f.insertComment(post, an.id(), null, "Root already hidden", "HIDDEN", earlier);
        UUID deletedRoot = f.insertComment(post, an.id(), null, "Root already deleted", "DELETED", earlier);
        UUID hiddenReply = f.insertComment(post, binh.id(), root, "Reply already hidden", "HIDDEN", earlier);

        f.assertError(f.reply(chi, reply, "Reply to a reply"), 422, "COMMENT_NOT_REPLYABLE");
        f.assertError(f.reply(chi, hiddenRoot, "Reply to a hidden root"), 404, "COMMENT_NOT_FOUND");
        f.assertError(f.reply(chi, deletedRoot, "Reply to a deleted root"), 404, "COMMENT_NOT_FOUND");
        // 404 before 422: a hidden reply counts as "not there", not as "cannot be replied to".
        f.assertError(f.reply(chi, hiddenReply, "Reply to a hidden reply"), 404, "COMMENT_NOT_FOUND");
        f.assertError(f.reply(an, UUID.randomUUID(), "Reply to a missing comment"), 404, "COMMENT_NOT_FOUND");

        // None of the calls above added a row.
        assertThat(f.countComments("user_id = ?", chi.id())).isZero();
        assertThat(f.countComments("parent_id = ?", reply)).isZero();
    }

    @Test
    void each_root_has_at_most_30_replies_counting_hidden_and_deleted_ones() throws Exception {
        Post post = f.publishedPost("Thirty replies");
        Reader an = f.reader("an");
        Reader last = f.reader("cuoi");
        Instant base = Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.SECONDS);
        UUID root = f.insertComment(post, an.id(), null, "Busy root", "VISIBLE", base);
        for (int i = 0; i < 29; i++) {
            String status = i == 0 ? "HIDDEN" : i == 1 ? "DELETED" : "VISIBLE";
            f.insertComment(post, an.id(), root, "Reply number " + i, status, base.plusSeconds(i + 1L));
        }

        UUID thirtieth = f.createdId(f.reply(last, root, "Thirtieth reply"));
        f.assertError(f.reply(last, root, "Thirty-first reply"), 422, "COMMENT_NOT_REPLYABLE");

        assertThat(f.countComments("parent_id = ?", root)).isEqualTo(30);
        List<UUID> shown = replyIds(thread(f.page(post), root));
        // 27 VISIBLE replies written with SQL plus the 30th reply; the hidden and the deleted replies do not
        // show but still take a slot.
        assertThat(shown).hasSize(28).endsWith(thirtieth);
    }

    // --- Edit and delete -------------------------------------------------------------------------------

    @Test
    void writer_can_edit_own_comment_and_identical_content_is_a_noop() throws Exception {
        Post post = f.publishedPost("Edit comment");
        Reader an = f.reader("an");
        UUID id = f.createdId(f.create(an, post, "First version"));
        Map<String, Object> before = f.row(id);

        // Identical after sanitizing: 200, "edited" not switched on, the row is not touched.
        JsonNode same = f.data(f.edit(an, id, "  First version \n").andExpect(status().isOk()));
        assertThat(same.path("content").asString()).isEqualTo("First version");
        assertThat(same.path("edited").asBoolean()).isFalse();
        assertThat(same.path("editedAt").isNull()).isTrue();
        assertThat(f.row(id).get("edited_at")).isNull();
        assertThat(f.row(id).get("updated_at")).isEqualTo(before.get("updated_at"));

        JsonNode edited =
                f.data(f.edit(an, id, "Edited version\n\n\n\nplus one line").andExpect(status().isOk()));
        assertThat(edited.path("id").asString()).isEqualTo(id.toString());
        assertThat(edited.path("status").asString()).isEqualTo("VISIBLE");
        assertThat(edited.path("content").asString()).isEqualTo("Edited version\n\nplus one line");
        assertThat(edited.path("edited").asBoolean()).isTrue();
        assertThat(edited.path("mine").asBoolean()).isTrue();
        assertThat(edited.path("createdAt").asString())
                .isEqualTo(same.path("createdAt").asString());
        assertThat(f.row(id).get("edited_at")).isNotNull();
        // "edited at": exactly the edit time in the DB, present if and only if edited is true.
        Instant editedAt = Instant.parse(edited.path("editedAt").asString());
        assertThat(editedAt).isEqualTo(((Timestamp) f.row(id).get("edited_at")).toInstant());
        assertThat(editedAt)
                .isAfterOrEqualTo(Instant.parse(edited.path("createdAt").asString()));

        // Others read the new version, with "edited" and the edit time.
        JsonNode shown = thread(f.page(post), id).path("comment");
        assertThat(shown.path("content").asString()).isEqualTo("Edited version\n\nplus one line");
        assertThat(shown.path("edited").asBoolean()).isTrue();
        assertThat(Instant.parse(shown.path("editedAt").asString())).isEqualTo(editedAt);

        // Invalid content: 400, the saved version stays unchanged.
        f.assertError(f.edit(an, id, "x"), 400, "VALIDATION_ERROR");
        assertThat(f.row(id).get("content")).isEqualTo("Edited version\n\nplus one line");
    }

    @Test
    void editing_or_deleting_someone_elses_comment_is_403_and_userId_in_body_is_ignored() throws Exception {
        Post post = f.publishedPost("Comment permissions");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID anVisible = f.createdId(f.create(an, post, "An's, still visible"));
        UUID anHidden = f.createdId(f.create(an, post, "An's, to be hidden"));
        f.setCommentStatus(anHidden, "HIDDEN");

        f.assertError(f.edit(binh, anVisible, "Ben edits An's"), 403, "FORBIDDEN");
        f.assertError(f.remove(binh, anVisible), 403, "FORBIDDEN");
        // A userId in the body cannot change who edits: it is still the token owner.
        f.assertError(
                f.send(
                        put("/api/v1/comments/" + anVisible),
                        binh,
                        Map.of(
                                "content",
                                "Ben impersonates An",
                                "userId",
                                an.id().toString())),
                403,
                "FORBIDDEN");
        // 404 before 403: another user hidden comment is "not there", it does not reveal that it exists.
        f.assertError(f.edit(binh, anHidden, "Ben edits a hidden comment"), 404, "COMMENT_NOT_FOUND");
        f.assertError(f.remove(binh, anHidden), 404, "COMMENT_NOT_FOUND");

        assertThat(f.row(anVisible).get("content")).isEqualTo("An's, still visible");
        assertThat(f.row(anVisible).get("status")).isEqualTo("VISIBLE");
        assertThat(f.row(anHidden).get("status")).isEqualTo("HIDDEN");

        // Create with the userId and status of someone else: the comment still belongs to the caller, still
        // VISIBLE.
        UUID spoofed = f.createdId(f.send(
                post("/api/v1/posts/" + post.slug() + "/comments"),
                binh,
                Map.of("content", "Impersonating comment", "userId", an.id().toString(), "status", "HIDDEN")));
        assertThat(f.row(spoofed).get("user_id")).isEqualTo(binh.id());
        assertThat(f.row(spoofed).get("status")).isEqualTo("VISIBLE");
    }

    @Test
    void comment_no_longer_visible_is_404_even_for_the_writer() throws Exception {
        Post post = f.publishedPost("Hidden even for the writer");
        Reader an = f.reader("an");
        UUID hidden = f.createdId(f.create(an, post, "To be hidden"));
        f.setCommentStatus(hidden, "HIDDEN");

        // Cannot be edited to dodge moderation, cannot be deleted to erase the trail.
        f.assertError(f.edit(an, hidden, "Edit after hiding"), 404, "COMMENT_NOT_FOUND");
        f.assertError(f.remove(an, hidden), 404, "COMMENT_NOT_FOUND");

        assertThat(f.row(hidden).get("content")).isEqualTo("To be hidden");
        assertThat(f.row(hidden).get("status")).isEqualTo("HIDDEN");
    }

    @Test
    void soft_delete_keeps_original_content_root_with_replies_becomes_placeholder_root_without_replies_disappears()
            throws Exception {
        Post post = f.publishedPost("Comment placeholder");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        Reader chi = f.reader("chi");
        UUID withReplies = f.createdId(f.create(an, post, "Root to be deleted, replies remain"));
        UUID visibleReply = f.createdId(f.reply(binh, withReplies, "Reply still visible"));
        UUID hiddenReply = f.createdId(f.reply(chi, withReplies, "Reply to be hidden"));
        f.setCommentStatus(hiddenReply, "HIDDEN");
        UUID alone = f.createdId(f.create(an, post, "Root to be deleted, no replies"));
        Instant later = Instant.now().plusSeconds(60);
        UUID hiddenRoot = f.insertComment(post, an.id(), null, "Hidden root with replies", "HIDDEN", later);
        UUID underHidden = f.insertComment(
                post, binh.id(), hiddenRoot, "Reply under a hidden root", "VISIBLE", later.plusSeconds(1));
        UUID hiddenEverything =
                f.insertComment(post, an.id(), null, "Hidden root, reply hidden too", "HIDDEN", later.plusSeconds(2));
        f.insertComment(post, binh.id(), hiddenEverything, "Hidden reply", "HIDDEN", later.plusSeconds(3));

        MockHttpServletResponse deleted = f.remove(an, withReplies)
                .andExpect(status().isNoContent())
                .andReturn()
                .getResponse();
        assertThat(deleted.getContentAsString()).isEmpty();
        f.remove(an, alone).andExpect(status().isNoContent());

        // Soft delete: the content is kept for moderation.
        assertThat(f.row(withReplies).get("status")).isEqualTo("DELETED");
        assertThat(f.row(withReplies).get("content")).isEqualTo("Root to be deleted, replies remain");
        // The second time is 404, like any comment that is no longer visible.
        f.assertError(f.remove(an, withReplies), 404, "COMMENT_NOT_FOUND");

        // Anonymous or the writer themselves: the placeholder reveals nothing of the deleted or hidden
        // comment.
        for (String bearer : Arrays.asList(null, an.bearer())) {
            JsonNode page = f.data(f.list(post, bearer, "size", "20").andExpect(status().isOk()));
            assertThat(rootIds(page)).containsExactly(withReplies, hiddenRoot);

            JsonNode deletedThread = thread(page, withReplies);
            assertPlaceholder(deletedThread.path("comment"), "DELETED");
            assertThat(replyIds(deletedThread)).containsExactly(visibleReply);

            JsonNode hiddenThread = thread(page, hiddenRoot);
            assertPlaceholder(hiddenThread.path("comment"), "HIDDEN");
            assertThat(replyIds(hiddenThread)).containsExactly(underHidden);

            assertThat(f.list(post, bearer).andReturn().getResponse().getContentAsString())
                    .doesNotContain("Root to be deleted")
                    .doesNotContain("Hidden root")
                    .doesNotContain("Reply to be hidden");
        }
    }

    private static void assertPlaceholder(JsonNode comment, String status) {
        assertThat(comment.path("status").asString()).isEqualTo(status);
        assertThat(comment.path("content").isNull()).as("content").isTrue();
        assertThat(comment.path("author").isNull()).as("author").isTrue();
        assertThat(comment.path("edited").asBoolean()).as("edited").isFalse();
        assertThat(comment.path("mine").asBoolean()).as("mine").isFalse();
        assertThat(comment.path("createdAt").asString()).isNotEmpty();
        assertThat(comment.path("editedAt").isNull()).as("editedAt").isTrue();
        assertThat(comment.path("likeCount").asLong()).as("likeCount").isZero();
        assertThat(comment.path("likedByMe").asBoolean()).as("likedByMe").isFalse();
    }

    // --- Content ---------------------------------------------------------------------------------------

    @Test
    void html_is_stored_verbatim_and_returned_as_a_json_string() throws Exception {
        Post post = f.publishedPost("Comment with HTML tags");
        Reader an = f.reader("an");
        String payload = "<script>alert(1)</script> <img src=x onerror=alert(1)> \"double quotes\" & 'single quotes'";

        ResultActions created = f.create(an, post, payload).andExpect(status().isCreated());
        assertThat(created.andReturn().getResponse().getContentType()).startsWith("application/json");
        UUID id = UUID.fromString(f.data(created).path("id").asString());

        assertThat(f.data(created).path("content").asString()).isEqualTo(payload);
        assertThat(f.row(id).get("content")).isEqualTo(payload);
        assertThat(thread(f.page(post), id).path("comment").path("content").asString())
                .isEqualTo(payload);
    }

    @Test
    void content_outside_2_to_2000_characters_or_without_visible_characters_is_400() throws Exception {
        Post post = f.publishedPost("Comment length");
        Reader an = f.reader("an");
        String path = "/api/v1/posts/" + post.slug() + "/comments";

        // Also strings made only of non-breaking spaces (U+00A0, U+2007, U+202F: strip() does not trim them)
        // and strings made only of Arabic letter marks U+061C (bidi control characters, dropped when
        // sanitizing).
        for (String content : List.of(
                "a",
                "a".repeat(2001),
                " \n\t ",
                cp(0x200B, 0x200B),
                cp(0x200D, 0x200D),
                cp(0x00A0, 0x00A0),
                cp(0x2007, 0x202F, 0x00A0),
                cp(0x061C, 0x061C),
                "a".repeat(10_001))) {
            f.assertError(f.create(an, post, content), 400, "VALIDATION_ERROR");
        }
        for (String body : List.of("{\"content\":null}", "{}", "not JSON")) {
            f.assertError(
                    mockMvc.perform(post(path)
                            .header("Authorization", an.bearer())
                            .contentType(APPLICATION_JSON)
                            .content(body)),
                    400,
                    "VALIDATION_ERROR");
        }
        assertThat(f.countComments("post_id = ?", post.id())).isZero();

        // The upper bound is still accepted, and none of the 400s above spend rate limit slots (5 per
        // minute).
        UUID longest = f.createdId(f.create(an, post, "a".repeat(2000)));
        assertThat((String) f.row(longest).get("content")).hasSize(2000);
        String emoji = cp(0x1F600).repeat(2000);
        assertThat(f.data(f.create(an, post, emoji).andExpect(status().isCreated()))
                        .path("content")
                        .asString())
                .isEqualTo(emoji);
    }

    // --- Paths, cursors, posts -------------------------------------------------------------------------

    @Test
    void malformed_id_is_400_while_wellformed_missing_id_is_404() throws Exception {
        Reader an = f.reader("an");
        String valid = "{\"content\":\"Valid content\"}";

        f.assertError(
                mockMvc.perform(put("/api/v1/comments/khong-phai-uuid")
                        .header("Authorization", an.bearer())
                        .contentType(APPLICATION_JSON)
                        .content(valid)),
                400,
                "VALIDATION_ERROR");
        f.assertError(
                mockMvc.perform(delete("/api/v1/comments/12345").header("Authorization", an.bearer())),
                400,
                "VALIDATION_ERROR");
        f.assertError(
                mockMvc.perform(post("/api/v1/comments/khong-phai-uuid/replies")
                        .header("Authorization", an.bearer())
                        .contentType(APPLICATION_JSON)
                        .content(valid)),
                400,
                "VALIDATION_ERROR");

        f.assertError(f.edit(an, UUID.randomUUID(), "Valid content"), 404, "COMMENT_NOT_FOUND");
        f.assertError(f.remove(an, UUID.randomUUID()), 404, "COMMENT_NOT_FOUND");
    }

    @Test
    void malformed_cursor_or_page_size_is_400() throws Exception {
        Post post = f.publishedPost("Malformed cursor");
        String notAUuid = Base64.getUrlEncoder()
                .withoutPadding()
                .encodeToString("1791428645123456:khong-phai-uuid".getBytes(StandardCharsets.US_ASCII));

        f.assertError(f.list(post, null, "after", "khong phai con tro!"), 400, "VALIDATION_ERROR");
        f.assertError(f.list(post, null, "after", notAUuid), 400, "VALIDATION_ERROR");
        f.assertError(f.list(post, null, "after", "A".repeat(500)), 400, "VALIDATION_ERROR");
        f.assertError(f.list(post, null, "size", "nhieu"), 400, "VALIDATION_ERROR");
        // An empty after is the first page.
        f.list(post, null, "after", "").andExpect(status().isOk());
    }

    @Test
    void unpublished_withdrawn_archived_or_missing_post_is_404_POST_NOT_FOUND() throws Exception {
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        Post draft = f.draftPost("Not launched yet");
        Post withdrawn = f.publishedPost("To be taken down");
        UUID before = f.createdId(f.create(an, withdrawn, "Comment while the post is published"));
        f.unpublish(withdrawn);
        Post archived = f.publishedPost("To be archived");
        f.archive(archived);
        Post unknown = new Post(UUID.randomUUID(), "khong-co-bai-nay-" + f.suffix);

        for (Post post : List.of(draft, withdrawn, archived, unknown)) {
            f.assertError(f.list(post, null), 404, "POST_NOT_FOUND");
            f.assertError(f.list(post, an.bearer()), 404, "POST_NOT_FOUND");
            f.assertError(f.create(binh, post, "Comment on a non-public post"), 404, "POST_NOT_FOUND");
        }
        assertThat(f.countComments("user_id = ?", binh.id())).isZero();

        // Comments of a withdrawn post are also 404: cannot be replied to, edited or deleted, and they stay
        // intact.
        f.assertError(f.reply(an, before, "Reply on an unpublished post"), 404, "COMMENT_NOT_FOUND");
        f.assertError(f.edit(an, before, "Edit on an unpublished post"), 404, "COMMENT_NOT_FOUND");
        f.assertError(f.remove(an, before), 404, "COMMENT_NOT_FOUND");
        assertThat(f.row(before).get("status")).isEqualTo("VISIBLE");
        assertThat(f.row(before).get("content")).isEqualTo("Comment while the post is published");

        // Publish again: the comment shows again and can be edited.
        f.republish(withdrawn);
        assertThat(rootIds(f.page(withdrawn))).containsExactly(before);
        f.edit(an, before, "Edit after republishing").andExpect(status().isOk());
    }

    @Test
    void deleting_a_post_deletes_all_its_comments() throws Exception {
        Post post = f.publishedPost("To be deleted with the comment");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID root = f.createdId(f.create(an, post, "Root of a post to be deleted"));
        f.createdId(f.reply(binh, root, "Reply of a post to be deleted"));

        f.deletePost(post);

        assertThat(f.countComments("post_id = ?", post.id())).isZero();
        f.assertError(f.list(post, null), 404, "POST_NOT_FOUND");
        f.assertError(f.edit(an, root, "Edit after the post is deleted"), 404, "COMMENT_NOT_FOUND");
    }

    @Test
    void suspended_user_cannot_write_even_with_valid_token_but_can_still_read() throws Exception {
        Post post = f.publishedPost("Suspended user");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID anComment = f.createdId(f.create(an, post, "Written before suspension"));
        UUID binhComment = f.createdId(f.create(binh, post, "Comment by Ben"));

        auth.setStatus(an.id(), UserStatus.SUSPENDED);

        f.assertError(f.create(an, post, "Written after suspension"), 403, "USER_SUSPENDED");
        f.assertError(f.reply(an, binhComment, "Reply after suspension"), 403, "USER_SUSPENDED");
        f.assertError(f.edit(an, anComment, "Edit after suspension"), 403, "USER_SUSPENDED");
        f.assertError(f.remove(an, anComment), 403, "USER_SUSPENDED");
        // Checked before anything else: even writes that another user would get 400 or 404 for.
        f.assertError(f.edit(an, UUID.randomUUID(), "x"), 403, "USER_SUSPENDED");

        assertThat(f.countComments("user_id = ?", an.id())).isEqualTo(1);
        assertThat(f.row(anComment).get("content")).isEqualTo("Written before suspension");
        assertThat(f.row(anComment).get("status")).isEqualTo("VISIBLE");
        f.list(post, an.bearer()).andExpect(status().isOk());

        // Unsuspending takes effect from the next write, with the same token.
        auth.setStatus(an.id(), UserStatus.ACTIVE);
        f.edit(an, anComment, "Edit after unsuspension").andExpect(status().isOk());
    }

    // --- Pagination ------------------------------------------------------------------------------------

    @Test
    void keyset_cursor_neither_repeats_nor_skips_when_comments_added_or_deleted_between_pages() throws Exception {
        Post post = f.publishedPost("Comment pagination");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        Instant base = Instant.now().minus(2, ChronoUnit.HOURS).truncatedTo(ChronoUnit.SECONDS);
        List<UUID> r = new ArrayList<>();
        for (int i = 0; i < 9; i++) {
            r.add(f.insertComment(post, an.id(), null, "Root number " + i, "VISIBLE", base.plusSeconds(i * 10L)));
        }
        // r9 and r10 share one instant: the order between them is the id (Postgres compares uuid byte by
        // byte, the same as the order of the lowercase hex text), and the boundary between pages 3 and 4
        // falls exactly between them.
        List<UUID> tied = new ArrayList<>(List.of(UUID.randomUUID(), UUID.randomUUID()));
        tied.sort((a, b) -> a.toString().compareTo(b.toString()));
        for (UUID id : tied) {
            r.add(f.insertComment(
                    id, post, an.id(), null, "Root at the same instant", "VISIBLE", base.plusSeconds(100)));
        }
        r.add(f.insertComment(post, an.id(), null, "Root number 11", "VISIBLE", base.plusSeconds(110)));

        JsonNode page1 = f.data(f.list(post, null, "size", "5").andExpect(status().isOk()));
        assertThat(rootIds(page1)).containsExactlyElementsOf(r.subList(0, 5));
        String cursor1 = page1.path("nextCursor").asString();
        assertThat(cursor1).matches("[A-Za-z0-9_-]+");

        // Between the two loads: a root of page 1 is deleted (offset pagination would make page 2 slide past
        // r5), a new root is inserted before the cursor, one is inserted in the middle of page 2, and a new
        // comment is posted.
        f.remove(an, r.get(2)).andExpect(status().isNoContent());
        UUID beforeCursor =
                f.insertComment(post, binh.id(), null, "Inserted before the cursor", "VISIBLE", base.plusSeconds(15));
        UUID insidePage2 = f.insertComment(
                post, binh.id(), null, "Inserted in the middle of page 2", "VISIBLE", base.plusSeconds(65));
        UUID newest = f.createdId(f.create(binh, post, "Newest comment"));

        JsonNode page2 =
                f.data(f.list(post, null, "size", "5", "after", cursor1).andExpect(status().isOk()));
        assertThat(rootIds(page2)).containsExactly(r.get(5), r.get(6), insidePage2, r.get(7), r.get(8));

        JsonNode page3 = f.data(f.list(
                        post,
                        null,
                        "size",
                        "1",
                        "after",
                        page2.path("nextCursor").asString())
                .andExpect(status().isOk()));
        assertThat(rootIds(page3)).containsExactly(r.get(9));

        JsonNode page4 = f.data(f.list(
                        post,
                        null,
                        "size",
                        "5",
                        "after",
                        page3.path("nextCursor").asString())
                .andExpect(status().isOk()));
        assertThat(rootIds(page4)).containsExactly(r.get(10), r.get(11), newest);
        assertThat(page4.path("nextCursor").isNull()).isTrue();

        List<UUID> seen = new ArrayList<>();
        for (JsonNode page : List.of(page1, page2, page3, page4)) {
            seen.addAll(rootIds(page));
        }
        assertThat(seen).doesNotHaveDuplicates().doesNotContain(beforeCursor);
    }

    @Test
    void default_page_size_10_clamped_to_1_to_20() throws Exception {
        Post post = f.publishedPost("Comment page size");
        Reader an = f.reader("an");
        Instant base = Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.SECONDS);
        List<UUID> roots = new ArrayList<>();
        for (int i = 0; i < 21; i++) {
            roots.add(f.insertComment(post, an.id(), null, "Root number " + i, "VISIBLE", base.plusSeconds(i)));
        }

        JsonNode byDefault = f.data(f.list(post, null).andExpect(status().isOk()));
        assertThat(rootIds(byDefault)).containsExactlyElementsOf(roots.subList(0, 10));

        JsonNode big = f.data(f.list(post, null, "size", "500").andExpect(status().isOk()));
        assertThat(rootIds(big)).containsExactlyElementsOf(roots.subList(0, 20));
        JsonNode rest = f.data(f.list(
                        post,
                        null,
                        "size",
                        "500",
                        "after",
                        big.path("nextCursor").asString())
                .andExpect(status().isOk()));
        assertThat(rootIds(rest)).containsExactly(roots.get(20));
        assertThat(rest.path("nextCursor").isNull()).isTrue();

        for (String size : List.of("0", "-3")) {
            JsonNode small = f.data(f.list(post, null, "size", size).andExpect(status().isOk()));
            assertThat(rootIds(small)).as("size=%s", size).containsExactly(roots.get(0));
        }
    }

    @Test
    void post_without_comments_is_empty_page_without_cursor() throws Exception {
        Post post = f.publishedPost("No comments yet");

        JsonNode page = f.page(post);

        assertThat(page.path("threads").isArray()).isTrue();
        assertThat(page.path("threads").size()).isZero();
        assertThat(page.path("nextCursor").isNull()).isTrue();
    }

    @Test
    void sql_statement_count_of_a_page_is_the_same_for_1_or_20_threads() throws Exception {
        Post small = f.publishedPost("One comment thread");
        Post large = f.publishedPost("Twenty comment threads");
        Reader replier = f.reader("tra-loi");
        Instant base = Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.SECONDS);
        UUID only = f.insertComment(small, f.reader("mot").id(), null, "Only root", "VISIBLE", base);
        f.insertComment(small, replier.id(), only, "Only reply", "VISIBLE", base.plusSeconds(1));
        for (int i = 0; i < 20; i++) {
            // Each root has a different writer: writers are not loaded per thread either.
            UUID root = f.insertComment(
                    large, f.reader("goc-" + i).id(), null, "Root number " + i, "VISIBLE", base.plusSeconds(i * 10L));
            f.insertComment(
                    large, replier.id(), root, "Reply to root number " + i, "VISIBLE", base.plusSeconds(i * 10L + 1));
        }

        long forOne = statementsFor(() -> assertThat(rootIds(f.page(small))).hasSize(1));
        long forTwenty = statementsFor(() -> assertThat(rootIds(f.page(large))).hasSize(20));
        long forTwentySignedIn = statementsFor(
                () -> f.list(large, replier.bearer(), "size", "20").andExpect(status().isOk()));

        // The post, the root ids, the roots with their writers, every reply with its writer, the like counts
        // of the whole page.
        assertThat(forOne).isEqualTo(5);
        assertThat(forTwenty).isEqualTo(forOne);
        // A logged-in user adds exactly three statements for the whole page, however long it is: the access check of
        // the token (the account row: role, status, tokens_valid_after), the check that the session of the token is
        // alive and the subject's own (audit 112: every token has one), and which comments they have liked themselves.
        assertThat(forTwentySignedIn).isEqualTo(forOne + 3);
    }

    private interface Request {
        void run() throws Exception;
    }

    /**
     * Number of SQL statements Hibernate prepares while a request runs. Hibernate statistics are off by
     * default and shared by the whole SessionFactory, so they are only turned on around that request and then
     * restored; tests run sequentially so nothing else slips into the count.
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
}
