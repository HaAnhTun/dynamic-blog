package com.blog.comment;

import static com.blog.comment.CommentFixtures.rootIds;
import static org.assertj.core.api.Assertions.assertThat;

import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.HeldTransaction;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

/**
 * Write races on comments: every change is a conditional UPDATE, and the number
 * of rows it changes decides the outcome, so a committed write is never overwritten by a write that was
 * waiting.
 *
 * The first part is the author side: the moderation is the author UPDATE statement itself, run via SQL and
 * held uncommitted. The second part is the admin side: moderation goes through the real moderation API, and
 * sometimes it is the one that waits.
 *
 * No reliance on thread scheduling luck ({@link HeldTransaction}): a transaction on its own thread holds the
 * row lock; requests are released one by one, and the test waits until Postgres reports each request as
 * waiting on exactly that lock ({@code pg_stat_activity}), meaning it has passed every check on committed
 * data; only then does the other transaction commit. When several requests wait on one row, Postgres
 * releases them in arrival order (the tuple lock queues), so the release order is the write order.
 */
@AutoConfigureMockMvc
class CommentConcurrencyIT extends AbstractIntegrationTest {

    // SQL fragment that identifies each UPDATE statement in pg_stat_activity: each fragment appears in
    // exactly one statement.
    private static final String AUTHOR_EDIT = "UPDATE comments c SET content";
    private static final String AUTHOR_DELETE = "AND user_id = ";
    private static final String ADMIN_HIDE = "SET status = 'HIDDEN'";
    private static final String ADMIN_RESTORE = "SET status = 'VISIBLE'";
    private static final String ADMIN_DELETE = "AND status <> 'DELETED'";
    // The insert of CommentRepository.insert...IfPublished; the insert of CommentFixtures has an extra status
    // column.
    private static final String COMMENT_INSERT =
            "INSERT INTO comments (id, post_id, user_id, parent_id, content, created_at";

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

    @ParameterizedTest(name = "{0} by the author while the comment is being changed to {1}")
    @CsvSource({"EDIT, HIDDEN", "EDIT, DELETED", "DELETE, HIDDEN", "DELETE, DELETED"})
    void author_write_waits_for_moderation_commit_then_gets_404_and_overwrites_nothing(
            String write, String moderatedStatus) throws Exception {
        Post post = f.publishedPost("Edit races moderation");
        Reader an = f.reader("an");
        UUID id = f.createdId(f.create(an, post, "Original content"));
        boolean edit = "EDIT".equals(write);

        ExecutorService pool = Executors.newSingleThreadExecutor();
        try (HeldTransaction moderation = hold(jdbc -> jdbc.update(
                "UPDATE comments SET status = ?, updated_at = now() WHERE id = ? AND status = 'VISIBLE'",
                moderatedStatus,
                id))) {
            Future<MockHttpServletResponse> authorWrite =
                    pool.submit(() -> (edit ? f.edit(an, id, "Content edited by the author") : f.remove(an, id))
                            .andReturn()
                            .getResponse());
            awaitWaitingOnLock(edit ? AUTHOR_EDIT : AUTHOR_DELETE, 1);
            moderation.commit();

            f.assertError(authorWrite.get(30, TimeUnit.SECONDS), 404, "COMMENT_NOT_FOUND");
        } finally {
            pool.shutdownNow();
        }

        Map<String, Object> row = f.row(id);
        assertThat(row.get("status")).isEqualTo(moderatedStatus);
        assertThat(row.get("content")).isEqualTo("Original content");
        assertThat(row.get("edited_at")).isNull();
    }

    @Test
    void reply_waits_for_parent_hide_commit_then_gets_404_and_adds_nothing() throws Exception {
        Post post = f.publishedPost("Reply races root hide");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID root = f.createdId(f.create(an, post, "Root about to be hidden"));

        ExecutorService pool = Executors.newSingleThreadExecutor();
        try (HeldTransaction hide = hold(jdbc -> jdbc.update(
                "UPDATE comments SET status = 'HIDDEN', updated_at = now() WHERE id = ? AND status = 'VISIBLE'",
                root))) {
            Future<MockHttpServletResponse> reply =
                    pool.submit(() -> f.reply(binh, root, "Reply just as the root is hidden")
                            .andReturn()
                            .getResponse());
            // The locked read of the parent comment: it waits, then re-reads the committed version instead of
            // the stale VISIBLE one.
            awaitWaitingOnLock("FOR NO KEY UPDATE OF c", 1);
            hide.commit();

            f.assertError(reply.get(30, TimeUnit.SECONDS), 404, "COMMENT_NOT_FOUND");
        } finally {
            pool.shutdownNow();
        }

        assertThat(f.countComments("parent_id = ?", root)).isZero();
        assertThat(f.row(root).get("status")).isEqualTo("HIDDEN");
    }

    @Test
    void reply_locks_post_before_parent_comment_so_race_with_post_delete_is_not_a_deadlock() throws Exception {
        Post post = f.publishedPost("Reply races post delete");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID root = f.createdId(f.create(an, post, "Root of a post about to be deleted"));

        ExecutorService pool = Executors.newSingleThreadExecutor();
        // The hard delete of the post (PostService.delete) is split in two steps so the reply can be slipped
        // in between: lock the post row as its DELETE does (FOR UPDATE), then delete, and ON DELETE CASCADE
        // locks then deletes each comment of the post.
        try (HeldTransaction postDelete =
                hold(jdbc -> jdbc.queryForList("SELECT id FROM posts WHERE id = ? FOR UPDATE", post.id()))) {
            Future<MockHttpServletResponse> reply =
                    pool.submit(() -> f.reply(binh, root, "Reply just as the post is deleted")
                            .andReturn()
                            .getResponse());
            // The reply waits on the post row, while holding no lock on the parent comment yet...
            awaitWaitingOnLock("FOR KEY SHARE OF p", 1);
            // ...so the post delete locks and deletes the parent comment immediately. In the old order
            // (parent comment first, post row when the INSERT checks the foreign key) the two sides would
            // wait for each other here and Postgres would abort one (40P01): a 500.
            postDelete.commitAfter(jdbc -> jdbc.update("DELETE FROM posts WHERE id = ?", post.id()));

            // The post row was deleted when the lock was released: nothing left to reply to.
            f.assertError(reply.get(30, TimeUnit.SECONDS), 404, "COMMENT_NOT_FOUND");
        } finally {
            pool.shutdownNow();
        }

        assertThat(f.countComments("post_id = ?", post.id())).isZero();
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM posts WHERE id = ?", Long.class, post.id()))
                .isZero();
    }

    @Test
    void
            root_comment_already_holding_post_row_makes_post_delete_wait_for_it_and_its_notification_then_delete_without_deadlock()
                    throws Exception {
        Post post = f.publishedPost("Root comment races post delete");
        Reader an = f.reader("an");

        ExecutorService pool = Executors.newFixedThreadPool(2);
        // Creating a root comment, after the comment insert (post_id foreign key: FOR KEY SHARE on the
        // post row), also inserts a notification for the post author (post_id and comment_id foreign keys of
        // notifications). Stop it exactly at the notification insert; the hard post delete reaching that
        // point must wait for the post row, and holds nothing the create needs: no deadlock.
        try (HeldTransaction gate = hold(jdbc -> jdbc.execute("LOCK TABLE notifications IN SHARE MODE"))) {
            Future<MockHttpServletResponse> creating =
                    pool.submit(() -> f.create(an, post, "Comment right before the post is deleted")
                            .andReturn()
                            .getResponse());
            awaitWaitingOnLock("INSERT INTO notifications", 1);
            Future<?> deleting =
                    pool.submit(() -> new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                        jdbcTemplate.queryForList("SELECT id FROM posts WHERE id = ? FOR UPDATE", post.id());
                        jdbcTemplate.update("DELETE FROM posts WHERE id = ?", post.id());
                    }));
            awaitWaitingOnLock("SELECT id FROM posts WHERE id = ", 1);
            gate.commit();

            MockHttpServletResponse created = creating.get(30, TimeUnit.SECONDS);
            assertThat(created.getStatus()).as(created.getContentAsString()).isEqualTo(201);
            // Does not throw: Postgres does not have to abort either side (40P01).
            deleting.get(30, TimeUnit.SECONDS);
        } finally {
            pool.shutdownNow();
        }

        assertThat(f.countComments("post_id = ?", post.id())).isZero();
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM notifications WHERE post_id = ?", Long.class, post.id()))
                .isZero();
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM posts WHERE id = ?", Long.class, post.id()))
                .isZero();
    }

    @Test
    void post_unpublished_just_before_root_comment_insert_returns_404_and_adds_nothing_to_unpublished_post()
            throws Exception {
        Post post = f.publishedPost("Unpublish during a comment");
        Reader an = f.reader("an");

        ExecutorService pool = Executors.newSingleThreadExecutor();
        // Lock the comments table (SHARE: readable, not writable): the create has passed the "post is
        // published" check and the duplicate-submission guard, so it must stop at the insert, as when it
        // waits on the per-user lock. The post is unpublished and committed meanwhile; the insert then runs
        // with a fresh snapshot and selects no post: 404, not a 201 on a draft.
        try (HeldTransaction gate = hold(jdbc -> jdbc.execute("LOCK TABLE comments IN SHARE MODE"))) {
            Future<MockHttpServletResponse> creating =
                    pool.submit(() -> f.create(an, post, "Comment just as the post is unpublished")
                            .andReturn()
                            .getResponse());
            awaitWaitingOnLock(COMMENT_INSERT, 1);
            f.unpublish(post);
            gate.commit();

            f.assertError(creating.get(30, TimeUnit.SECONDS), 404, "POST_NOT_FOUND");
        } finally {
            pool.shutdownNow();
        }

        assertThat(f.countComments("post_id = ?", post.id())).isZero();
    }

    @Test
    void post_unpublished_just_before_reply_insert_returns_404_and_adds_nothing_to_unpublished_post() throws Exception {
        Post post = f.publishedPost("Unpublish during a reply");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID root = f.createdId(f.create(an, post, "Root of a post about to be unpublished"));

        ExecutorService pool = Executors.newSingleThreadExecutor();
        // The reply holds FOR KEY SHARE on the post row, a lock that does not block unpublishing (FOR NO KEY
        // UPDATE): the post is unpublished and committed while the reply sits at the insert, after every
        // check on the parent comment.
        try (HeldTransaction gate = hold(jdbc -> jdbc.execute("LOCK TABLE comments IN SHARE MODE"))) {
            Future<MockHttpServletResponse> replying =
                    pool.submit(() -> f.reply(binh, root, "Reply just as the post is unpublished")
                            .andReturn()
                            .getResponse());
            awaitWaitingOnLock(COMMENT_INSERT, 1);
            f.unpublish(post);
            gate.commit();

            f.assertError(replying.get(30, TimeUnit.SECONDS), 404, "COMMENT_NOT_FOUND");
        } finally {
            pool.shutdownNow();
        }

        assertThat(f.countComments("parent_id = ?", root)).isZero();
        assertThat(f.countComments("post_id = ?", post.id())).isEqualTo(1);
    }

    @Test
    void several_users_replying_for_the_last_30th_slot_let_only_one_through() throws Exception {
        Post post = f.publishedPost("Fight for the last reply slot");
        Reader an = f.reader("an");
        Instant base = Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.SECONDS);
        UUID root = f.insertComment(post, an.id(), null, "Root with exactly one slot left", "VISIBLE", base);
        for (int i = 0; i < 29; i++) {
            f.insertComment(post, an.id(), root, "Reply number " + i, "VISIBLE", base.plusSeconds(i + 1L));
        }
        int contenders = 5;
        List<Reader> readers = new ArrayList<>();
        for (int i = 0; i < contenders; i++) {
            readers.add(f.reader("tranh-" + i));
        }

        // Five different people, so the per-user lock does not queue them: only the lock on the parent row
        // can. Holding that lock from the test makes all five replies pile up on that single slot and be
        // released at once: the harshest race possible.
        ExecutorService pool = Executors.newFixedThreadPool(contenders);
        List<Integer> statuses = new ArrayList<>();
        try (HeldTransaction parentLock =
                hold(jdbc -> jdbc.queryForList("SELECT id FROM comments WHERE id = ? FOR NO KEY UPDATE", root))) {
            List<Future<MockHttpServletResponse>> replies = new ArrayList<>();
            for (Reader reader : readers) {
                replies.add(pool.submit(() -> f.reply(reader, root, "Reply competing for the slot of " + reader.login())
                        .andReturn()
                        .getResponse()));
            }
            awaitWaitingOnLock("FOR NO KEY UPDATE OF c", contenders);
            parentLock.commit();

            for (Future<MockHttpServletResponse> reply : replies) {
                MockHttpServletResponse response = reply.get(60, TimeUnit.SECONDS);
                statuses.add(response.getStatus());
                if (response.getStatus() != 201) {
                    f.assertError(response, 422, "COMMENT_NOT_REPLYABLE");
                }
            }
        } finally {
            pool.shutdownNow();
        }

        assertThat(statuses).containsExactlyInAnyOrder(201, 422, 422, 422, 422);
        assertThat(f.countComments("parent_id = ?", root)).isEqualTo(30);
    }

    // --- Admin side: moderation through the real moderation API --------------------------------------------

    @ParameterizedTest(name = "{1} by the author queued behind the admin {0}")
    @CsvSource({"HIDE, EDIT", "HIDE, DELETE", "DELETE, EDIT", "DELETE, DELETE"})
    void api_moderation_committing_first_makes_the_waiting_author_write_get_404(String moderation, String write)
            throws Exception {
        Post post = f.publishedPost("Moderation before the author");
        Reader an = f.reader("an");
        UUID id = f.createdId(f.create(an, post, "Original content"));
        boolean hide = "HIDE".equals(moderation);
        boolean edit = "EDIT".equals(write);

        ExecutorService pool = Executors.newFixedThreadPool(2);
        try (HeldTransaction gate = lockRow(id)) {
            // The admin arrives first, the author second. The author write has passed every check (comment
            // still VISIBLE, right writer, post still published) when it reaches the UPDATE and has to queue
            // behind the admin.
            Future<MockHttpServletResponse> admin =
                    pool.submit(() -> (hide ? f.moderate(id, "HIDDEN") : f.adminDelete(id))
                            .andReturn()
                            .getResponse());
            awaitWaitingOnLock(hide ? ADMIN_HIDE : ADMIN_DELETE, 1);
            Future<MockHttpServletResponse> author =
                    pool.submit(() -> (edit ? f.edit(an, id, "Content edited by the author") : f.remove(an, id))
                            .andReturn()
                            .getResponse());
            awaitWaitingOnLock(edit ? AUTHOR_EDIT : AUTHOR_DELETE, 1);
            gate.commit();

            MockHttpServletResponse adminResponse = admin.get(30, TimeUnit.SECONDS);
            assertThat(adminResponse.getStatus())
                    .as(adminResponse.getContentAsString())
                    .isEqualTo(hide ? 200 : 204);
            f.assertError(author.get(30, TimeUnit.SECONDS), 404, "COMMENT_NOT_FOUND");
        } finally {
            pool.shutdownNow();
        }

        Map<String, Object> row = f.row(id);
        assertThat(row.get("status")).isEqualTo(hide ? "HIDDEN" : "DELETED");
        assertThat(row.get("content")).isEqualTo("Original content");
        assertThat(row.get("edited_at")).isNull();
    }

    @Test
    void author_delete_committing_first_makes_waiting_hide_get_409_while_unhide_changes_nothing() throws Exception {
        Post post = f.publishedPost("Author deletes before the admin");
        Reader an = f.reader("an");
        UUID id = f.createdId(f.create(an, post, "Original content"));

        ExecutorService pool = Executors.newFixedThreadPool(2);
        try (HeldTransaction gate = lockRow(id)) {
            Future<MockHttpServletResponse> authorDelete =
                    pool.submit(() -> f.remove(an, id).andReturn().getResponse());
            awaitWaitingOnLock(AUTHOR_DELETE, 1);
            Future<MockHttpServletResponse> hide =
                    pool.submit(() -> f.moderate(id, "HIDDEN").andReturn().getResponse());
            awaitWaitingOnLock(ADMIN_HIDE, 1);
            // Unhide runs while the delete is still uncommitted: the comment is VISIBLE so its UPDATE matches
            // no row, does not queue, writes nothing; 200 because it is already in the requested state.
            MockHttpServletResponse restore =
                    f.moderate(id, "VISIBLE").andReturn().getResponse();
            assertThat(restore.getStatus()).as(restore.getContentAsString()).isEqualTo(200);
            gate.commit();

            MockHttpServletResponse deleted = authorDelete.get(30, TimeUnit.SECONDS);
            assertThat(deleted.getStatus()).as(deleted.getContentAsString()).isEqualTo(204);
            // Hide re-reads after waiting: the comment was deleted by the author, not overwritten to HIDDEN.
            f.assertError(hide.get(30, TimeUnit.SECONDS), 409, "RESOURCE_CONFLICT");
        } finally {
            pool.shutdownNow();
        }

        assertThat(f.row(id).get("status")).isEqualTo("DELETED");
        // Once deleted, nothing brings it back.
        f.assertError(f.moderate(id, "VISIBLE"), 409, "RESOURCE_CONFLICT");
        assertThat(f.row(id).get("status")).isEqualTo("DELETED");
        assertThat(f.row(id).get("content")).isEqualTo("Original content");
    }

    @Test
    void unhide_waits_for_admin_delete_commit_then_gets_409_and_comment_does_not_come_back() throws Exception {
        Post post = f.publishedPost("Unhide races delete");
        Reader an = f.reader("an");
        UUID id = f.createdId(f.create(an, post, "Original content"));
        f.setCommentStatus(id, "HIDDEN");

        ExecutorService pool = Executors.newFixedThreadPool(2);
        try (HeldTransaction gate = lockRow(id)) {
            Future<MockHttpServletResponse> delete =
                    pool.submit(() -> f.adminDelete(id).andReturn().getResponse());
            awaitWaitingOnLock(ADMIN_DELETE, 1);
            Future<MockHttpServletResponse> restore =
                    pool.submit(() -> f.moderate(id, "VISIBLE").andReturn().getResponse());
            awaitWaitingOnLock(ADMIN_RESTORE, 1);
            gate.commit();

            MockHttpServletResponse deleted = delete.get(30, TimeUnit.SECONDS);
            assertThat(deleted.getStatus()).as(deleted.getContentAsString()).isEqualTo(204);
            f.assertError(restore.get(30, TimeUnit.SECONDS), 409, "RESOURCE_CONFLICT");
        } finally {
            pool.shutdownNow();
        }

        assertThat(f.row(id).get("status")).isEqualTo("DELETED");
        assertThat(rootIds(f.page(post))).isEmpty();
    }

    // --- Helpers ----------------------------------------------------------------------------------------

    private HeldTransaction hold(Consumer<JdbcTemplate> work) throws Exception {
        return new HeldTransaction(transactionManager, jdbcTemplate, work);
    }

    /** Write lock on a comment row without changing anything: every UPDATE matching that row must queue behind it. */
    private HeldTransaction lockRow(UUID commentId) throws Exception {
        return hold(jdbc -> jdbc.queryForList("SELECT id FROM comments WHERE id = ? FOR UPDATE", commentId));
    }

    private void awaitWaitingOnLock(String sqlFragment, int sessions) throws InterruptedException {
        HeldTransaction.awaitWaitingOnLock(jdbcTemplate, sqlFragment, sessions);
    }
}
