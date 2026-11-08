package com.blog.like;

import static com.blog.comment.CommentFixtures.thread;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.comment.CommentFixtures;
import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.comment.repository.CommentRepository;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.like.dto.LikeResponse;
import com.blog.like.repository.CommentLikeRepository;
import com.blog.like.service.CommentLikeService;
import com.blog.notification.repository.NotificationRepository;
import com.blog.notification.service.NotificationWriter;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.HeldTransaction;
import com.blog.user.entity.UserStatus;
import com.blog.user.service.CurrentUserService;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Comment likes: {@code PUT/DELETE /api/v1/comments/{id}/like}, and {@code likeCount}, {@code likedByMe},
 * {@code editedAt} on every comment. Same rules as post likes: idempotent, returns the server state, the DB
 * blocks duplicates; only VISIBLE comments on a published post.
 *
 * Each test creates its own fresh reader: the limit of 30 likes and unlikes per minute (shared with post
 * likes) and 5 comments per minute per person live in the memory of the shared context. Like notifications
 * have their own IT (NotificationIT); here we only check that every real like creates exactly one
 * notification, and the lock races.
 */
@AutoConfigureMockMvc
class CommentLikeIT extends AbstractIntegrationTest {

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

    @Autowired
    private CommentLikeRepository commentLikeRepository;

    @Autowired
    private CommentRepository commentRepository;

    @Autowired
    private NotificationRepository notificationRepository;

    @Autowired
    private CurrentUserService currentUserService;

    @Autowired
    private RateLimiter rateLimiter;

    private CommentFixtures f;

    @BeforeEach
    void setUp() {
        f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
    }

    @Test
    void like_relike_unlike_reunlike_all_200_with_server_state_and_count() throws Exception {
        Post post = f.publishedPost("Liked comment");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        Reader chi = f.reader("chi");
        UUID comment = f.createdId(f.create(an, post, "Comment to like"));

        JsonNode first = f.data(f.likeComment(binh, comment, true).andExpect(status().isOk()));
        assertThat(first.propertyNames()).containsExactlyInAnyOrder("liked", "count");
        assertState(first, true, 1);
        // Like again: still one like, still 200.
        assertState(f.data(f.likeComment(binh, comment, true).andExpect(status().isOk())), true, 1);
        assertThat(rows(comment)).isEqualTo(1);
        assertState(f.data(f.likeComment(chi, comment, true).andExpect(status().isOk())), true, 2);
        // Liking your own comment is allowed, as with posts.
        assertState(f.data(f.likeComment(an, comment, true).andExpect(status().isOk())), true, 3);

        assertState(f.data(f.likeComment(binh, comment, false).andExpect(status().isOk())), false, 2);
        // Unlike again: still 200.
        assertState(f.data(f.likeComment(binh, comment, false).andExpect(status().isOk())), false, 2);
        assertThat(rows(comment)).isEqualTo(2);

        // The comment page carries the counts, and likedByMe per viewer; a user who is not logged in always
        // gets false.
        assertLikes(post, null, comment, 2, false);
        assertLikes(post, an, comment, 2, true);
        assertLikes(post, binh, comment, 2, false);
        assertLikes(post, chi, comment, 2, true);
        // Never reveals who liked.
        assertThat(f.list(post, null).andReturn().getResponse().getContentAsString())
                .doesNotContain(chi.id().toString())
                .doesNotContain(chi.login());

        // Every new like by someone else notifies the writer once (unliking does not delete the
        // notification); liking your own does not. (The post belongs to the seeded admin, so the comment
        // itself already notified the admin: POST_COMMENTED, not counted here.)
        assertThat(f.countNotifications("comment_id = ? AND type = 'COMMENT_LIKED'", comment))
                .isEqualTo(2);
        assertThat(f.countNotifications("comment_id = ? AND type = 'COMMENT_LIKED' AND actor_id = ?", comment, an.id()))
                .isZero();
    }

    @Test
    void reply_can_be_liked_too_and_its_like_comes_with_the_reply_on_the_page() throws Exception {
        Post post = f.publishedPost("Like a reply");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID root = f.createdId(f.create(an, post, "Root with a reply"));
        UUID reply = f.createdId(f.reply(binh, root, "Liked reply"));

        assertState(f.data(f.likeComment(an, reply, true).andExpect(status().isOk())), true, 1);

        JsonNode shown = thread(f.data(f.list(post, an.bearer()).andExpect(status().isOk())), root);
        assertThat(shown.path("comment").path("likeCount").asLong()).isZero();
        assertThat(shown.path("replies").get(0).path("likeCount").asLong()).isEqualTo(1);
        assertThat(shown.path("replies").get(0).path("likedByMe").asBoolean()).isTrue();
    }

    @Test
    void anonymous_gets_401_suspended_user_gets_403_and_nothing_is_written() throws Exception {
        Post post = f.publishedPost("Like when not allowed");
        Reader an = f.reader("an");
        Reader suspended = f.reader("bi-khoa");
        UUID comment = f.createdId(f.create(an, post, "Nobody can like"));
        auth.setStatus(suspended.id(), UserStatus.SUSPENDED);

        for (boolean like : List.of(true, false)) {
            f.assertError(f.likeComment(null, comment, like), 401, "UNAUTHENTICATED");
            f.assertError(f.likeComment(suspended, comment, like), 403, "USER_SUSPENDED");
        }

        assertThat(rows(comment)).isZero();
        assertThat(f.countNotifications("comment_id = ? AND type = 'COMMENT_LIKED'", comment))
                .isZero();
    }

    @Test
    void hidden_deleted_placeholder_unpublished_archived_or_missing_comment_is_404_while_malformed_id_is_400()
            throws Exception {
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        Reader chi = f.reader("chi");
        Post post = f.publishedPost("Like a comment that is no longer visible");
        UUID hidden = f.createdId(f.create(an, post, "Comment to be hidden"));
        f.setCommentStatus(hidden, "HIDDEN");
        UUID deleted = f.createdId(f.create(an, post, "Comment to be deleted"));
        f.remove(an, deleted).andExpect(status().isNoContent());
        // A hidden root that still has visible replies: on the page it is a placeholder, not a likeable
        // comment.
        UUID placeholder = f.createdId(f.create(an, post, "Hidden root with replies"));
        f.createdId(f.reply(binh, placeholder, "Reply still visible"));
        f.setCommentStatus(placeholder, "HIDDEN");
        Post unpublished = f.publishedPost("Post to be unpublished");
        UUID onUnpublished = f.createdId(f.create(chi, unpublished, "Comment on a post to be unpublished"));
        f.likeComment(binh, onUnpublished, true).andExpect(status().isOk());
        f.unpublish(unpublished);
        Post archived = f.publishedPost("Post to be archived");
        UUID onArchived = f.createdId(f.create(chi, archived, "Comment on a post to be archived"));
        f.archive(archived);

        for (UUID id : List.of(hidden, deleted, placeholder, onUnpublished, onArchived, UUID.randomUUID())) {
            for (boolean like : List.of(true, false)) {
                f.assertError(f.likeComment(binh, id, like), 404, "COMMENT_NOT_FOUND");
            }
        }
        for (boolean like : List.of(true, false)) {
            String path = "/api/v1/comments/khong-phai-uuid/like";
            f.assertError(
                    mockMvc.perform((like ? put(path) : delete(path)).header("Authorization", binh.bearer())),
                    400,
                    "VALIDATION_ERROR");
        }

        assertThat(rows(hidden) + rows(deleted) + rows(placeholder) + rows(onArchived))
                .isZero();
        // A like from before the post was unpublished remains (a 404 unlike deletes nothing), and shows again
        // when the post is republished.
        assertThat(rows(onUnpublished)).isEqualTo(1);
        f.republish(unpublished);
        assertLikes(unpublished, binh, onUnpublished, 1, true);
    }

    @Test
    void twenty_simultaneous_likes_give_exactly_one_row_one_notification_all_200_and_no_error_in_log()
            throws Exception {
        Post post = f.publishedPost("Like comment repeatedly");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID comment = f.createdId(f.create(an, post, "Comment liked repeatedly"));
        int calls = 20;

        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        List<MockHttpServletResponse> responses = new ArrayList<>();
        CountDownLatch go = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(calls);
        try {
            List<Future<MockHttpServletResponse>> futures = new ArrayList<>();
            for (int i = 0; i < calls; i++) {
                futures.add(pool.submit(() -> {
                    go.await();
                    return f.likeComment(binh, comment, true).andReturn().getResponse();
                }));
            }
            go.countDown();
            for (Future<MockHttpServletResponse> future : futures) {
                responses.add(future.get(60, TimeUnit.SECONDS));
            }
        } finally {
            pool.shutdownNow();
            root.detachAppender(logs);
        }

        for (MockHttpServletResponse response : responses) {
            assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
            assertState(objectMapper.readTree(response.getContentAsString()).path("data"), true, 1);
        }
        assertThat(rows(comment)).isEqualTo(1);
        assertThat(f.countNotifications("comment_id = ? AND type = 'COMMENT_LIKED'", comment))
                .isEqualTo(1);
        assertThat(logs.list)
                .as("no duplicate-key error or any other error")
                .noneMatch(event -> event.getLevel().isGreaterOrEqual(Level.ERROR));
    }

    @Test
    void comment_hidden_just_before_like_insert_returns_404_not_liked() throws Exception {
        Post post = f.publishedPost("Hide comment during a like");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID comment = f.createdId(f.create(an, post, "Comment about to be hidden"));

        ExecutorService pool = Executors.newSingleThreadExecutor();
        // Lock the comment_likes table (SHARE: readable, not writable): the like has passed every check, so
        // it must stop at the insert. The comment is hidden and committed meanwhile; the insert then runs
        // with a fresh snapshot and selects no comment, 0 rows, and this user has no like: 404, not "liked",
        // and no notification.
        try (HeldTransaction gate = hold(jdbc -> jdbc.execute("LOCK TABLE comment_likes IN SHARE MODE"))) {
            Future<MockHttpServletResponse> liking = pool.submit(
                    () -> f.likeComment(binh, comment, true).andReturn().getResponse());
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "INSERT INTO comment_likes", 1);
            f.setCommentStatus(comment, "HIDDEN");
            gate.commit();

            f.assertError(liking.get(30, TimeUnit.SECONDS), 404, "COMMENT_NOT_FOUND");
        } finally {
            pool.shutdownNow();
        }

        assertThat(rows(comment)).isZero();
        assertThat(f.countNotifications("comment_id = ? AND type = 'COMMENT_LIKED'", comment))
                .isZero();
    }

    @Test
    void like_locks_post_before_comment_so_race_with_post_delete_is_not_a_deadlock() throws Exception {
        Post post = f.publishedPost("Comment like races post delete");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID comment = f.createdId(f.create(an, post, "Comment of a post about to be deleted"));

        ExecutorService pool = Executors.newSingleThreadExecutor();
        // The hard post delete is split in two steps, like CommentConcurrencyIT: lock the post row as its
        // DELETE does, then delete, and ON DELETE CASCADE locks then deletes each comment of the post.
        try (HeldTransaction postDelete =
                hold(jdbc -> jdbc.queryForList("SELECT id FROM posts WHERE id = ? FOR UPDATE", post.id()))) {
            Future<MockHttpServletResponse> liking = pool.submit(
                    () -> f.likeComment(binh, comment, true).andReturn().getResponse());
            // The like waits on the post row, before touching the comment (foreign key of comment_likes)...
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "FOR KEY SHARE OF p", 1);
            // ...so the post delete locks and deletes the comment right away. Without locking the post first
            // the like would hold the comment and then want the post row (post_id foreign key of
            // notifications), while the delete holds the post row and wants the comment: 40P01, 500.
            postDelete.commitAfter(jdbc -> jdbc.update("DELETE FROM posts WHERE id = ?", post.id()));

            f.assertError(liking.get(30, TimeUnit.SECONDS), 404, "COMMENT_NOT_FOUND");
        } finally {
            pool.shutdownNow();
        }

        assertThat(rows(comment)).isZero();
        assertThat(f.countNotifications("post_id = ?", post.id())).isZero();
        assertThat(f.countComments("post_id = ?", post.id())).isZero();
    }

    @Test
    void post_delete_arriving_when_like_holds_post_row_waits_for_like_and_notification_then_deletes() throws Exception {
        Post post = f.publishedPost("Delete post when a comment like is nearly done");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID comment = f.createdId(f.create(an, post, "Comment liked before the post is deleted"));

        ExecutorService pool = Executors.newFixedThreadPool(2);
        // The like has locked the post row and inserted the like, then stops at the notification insert (the
        // new post_id, comment_id foreign keys of V22). The post delete reaching that point waits on the post
        // row, and holds nothing the like needs: no deadlock.
        try (HeldTransaction gate = hold(jdbc -> jdbc.execute("LOCK TABLE notifications IN SHARE MODE"))) {
            Future<MockHttpServletResponse> liking = pool.submit(
                    () -> f.likeComment(binh, comment, true).andReturn().getResponse());
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "INSERT INTO notifications", 1);
            Future<?> deleting =
                    pool.submit(() -> new TransactionTemplate(transactionManager).executeWithoutResult(status -> {
                        jdbcTemplate.queryForList("SELECT id FROM posts WHERE id = ? FOR UPDATE", post.id());
                        jdbcTemplate.update("DELETE FROM posts WHERE id = ?", post.id());
                    }));
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "SELECT id FROM posts WHERE id = ", 1);
            gate.commit();

            MockHttpServletResponse liked = liking.get(30, TimeUnit.SECONDS);
            assertThat(liked.getStatus()).as(liked.getContentAsString()).isEqualTo(200);
            // Does not throw: Postgres does not have to abort either side.
            deleting.get(30, TimeUnit.SECONDS);
        } finally {
            pool.shutdownNow();
        }

        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM posts WHERE id = ?", Long.class, post.id()))
                .isZero();
        assertThat(rows(comment)).isZero();
        assertThat(f.countNotifications("post_id = ?", post.id())).isZero();
    }

    @Test
    void old_like_removed_from_other_tab_right_after_insert_is_liked_again_and_notifies_exactly_once()
            throws Exception {
        Post post = f.publishedPost("Like comment from two tabs");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID comment = f.createdId(f.create(an, post, "Comment liked from two tabs"));
        f.likeComment(binh, comment, true).andExpect(status().isOk());
        // The writer deleted the notification of the first like: the re-insert below is a new like, notifying
        // once more.
        assertThat(jdbcTemplate.update(
                        "DELETE FROM notifications WHERE comment_id = ? AND type = 'COMMENT_LIKED'", comment))
                .isEqualTo(1);

        // As in PostLikeIT: the insert hits the old like and adds nothing; right before the first re-read,
        // the other tab unlikes and commits, on another thread, outside the transaction of the like.
        AtomicBoolean unlikedElsewhere = new AtomicBoolean();
        ExecutorService otherTab = Executors.newSingleThreadExecutor();
        CommentLikeRepository racing = (CommentLikeRepository) Proxy.newProxyInstance(
                CommentLikeRepository.class.getClassLoader(),
                new Class<?>[] {CommentLikeRepository.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("existsById") && unlikedElsewhere.compareAndSet(false, true)) {
                        otherTab.submit(() -> jdbcTemplate.update(
                                        "DELETE FROM comment_likes WHERE comment_id = ? AND user_id = ?",
                                        comment,
                                        binh.id()))
                                .get(30, TimeUnit.SECONDS);
                    }
                    try {
                        return method.invoke(commentLikeRepository, args);
                    } catch (InvocationTargetException e) {
                        throw e.getCause();
                    }
                });
        AtomicInteger notified = new AtomicInteger();
        NotificationWriter countingWriter = new NotificationWriter(notificationRepository) {
            @Override
            public void commentLiked(UUID actorId, UUID commentId) {
                notified.incrementAndGet();
                super.commentLiked(actorId, commentId);
            }
        };
        CommentLikeService service =
                new CommentLikeService(racing, commentRepository, countingWriter, currentUserService, rateLimiter);

        LikeResponse response;
        try {
            SecurityContextHolder.getContext()
                    .setAuthentication(new JwtAuthenticationToken(Jwt.withTokenValue("token")
                            .header("alg", "HS256")
                            .subject(binh.id().toString())
                            .claim("role", "USER")
                            .build()));
            response = new TransactionTemplate(transactionManager).execute(tx -> service.like(comment));
        } finally {
            SecurityContextHolder.clearContext();
            otherTab.shutdownNow();
        }

        assertThat(unlikedElsewhere).isTrue();
        assertThat(response).isEqualTo(new LikeResponse(true, 1));
        assertThat(rows(comment)).isEqualTo(1);
        assertThat(notified).hasValue(1);
        assertThat(f.countNotifications("comment_id = ? AND type = 'COMMENT_LIKED'", comment))
                .isEqualTo(1);
    }

    @Test
    void comment_page_carries_likeCount_likedByMe_editedAt_while_placeholder_carries_0_false_null() throws Exception {
        Post post = f.publishedPost("Counts on the comment page");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        Reader chi = f.reader("chi");
        UUID root = f.createdId(f.create(an, post, "Liked root"));
        UUID reply = f.createdId(f.reply(binh, root, "Liked reply"));
        UUID hiddenRoot = f.createdId(f.create(chi, post, "Root to be hidden"));
        f.createdId(f.reply(an, hiddenRoot, "Reply under a root to be hidden"));
        f.likeComment(binh, root, true).andExpect(status().isOk());
        f.likeComment(chi, root, true).andExpect(status().isOk());
        f.likeComment(an, reply, true).andExpect(status().isOk());
        f.likeComment(an, hiddenRoot, true).andExpect(status().isOk());
        f.edit(an, root, "Liked root, edited").andExpect(status().isOk());
        // A root that was edited and liked, then hidden: the placeholder reveals neither the edit nor the
        // likes.
        f.edit(chi, hiddenRoot, "Root to be hidden, edited").andExpect(status().isOk());
        f.setCommentStatus(hiddenRoot, "HIDDEN");

        JsonNode guest = f.data(f.list(post, null, "size", "20").andExpect(status().isOk()));
        JsonNode rootShown = thread(guest, root).path("comment");
        assertThat(rootShown.path("likeCount").asLong()).isEqualTo(2);
        assertThat(rootShown.path("likedByMe").asBoolean()).isFalse();
        assertThat(rootShown.path("editedAt").isString()).isTrue();
        JsonNode replyShown = thread(guest, root).path("replies").get(0);
        assertThat(replyShown.path("likeCount").asLong()).isEqualTo(1);
        assertThat(replyShown.path("likedByMe").asBoolean()).isFalse();
        assertThat(replyShown.path("editedAt").isNull()).isTrue();
        JsonNode placeholder = thread(guest, hiddenRoot).path("comment");
        assertThat(placeholder.path("status").asString()).isEqualTo("HIDDEN");
        assertThat(placeholder.path("likeCount").asLong()).isZero();
        assertThat(placeholder.path("likedByMe").asBoolean()).isFalse();
        assertThat(placeholder.path("editedAt").isNull()).isTrue();

        // likedByMe per viewer; a placeholder is always false, even for a user who liked it.
        JsonNode asAn = f.data(f.list(post, an.bearer(), "size", "20").andExpect(status().isOk()));
        assertThat(thread(asAn, root).path("comment").path("likedByMe").asBoolean())
                .isFalse();
        assertThat(thread(asAn, root).path("replies").get(0).path("likedByMe").asBoolean())
                .isTrue();
        assertThat(thread(asAn, hiddenRoot).path("comment").path("likedByMe").asBoolean())
                .isFalse();
        JsonNode asBinh = f.data(f.list(post, binh.bearer(), "size", "20").andExpect(status().isOk()));
        assertThat(thread(asBinh, root).path("comment").path("likedByMe").asBoolean())
                .isTrue();
        assertThat(thread(asBinh, root).path("replies").get(0).path("likedByMe").asBoolean())
                .isFalse();

        // editedAt is present exactly when edited is true, on every comment of every page.
        for (JsonNode page : List.of(guest, asAn, asBinh)) {
            for (JsonNode thread : page.path("threads")) {
                assertEditedAtMatchesEdited(thread.path("comment"));
                thread.path("replies").forEach(CommentLikeIT::assertEditedAtMatchesEdited);
            }
        }
    }

    @Test
    void deleting_a_post_deletes_all_its_comment_likes() throws Exception {
        Post post = f.publishedPost("Post with a liked comment to be deleted");
        Reader an = f.reader("an");
        UUID comment = f.createdId(f.create(an, post, "Comment of a post to be deleted"));
        f.likeComment(f.reader("binh"), comment, true).andExpect(status().isOk());
        f.likeComment(f.reader("chi"), comment, true).andExpect(status().isOk());
        assertThat(rows(comment)).isEqualTo(2);

        f.deletePost(post);

        assertThat(rows(comment)).isZero();
        assertThat(f.countNotifications("post_id = ?", post.id())).isZero();
    }

    @Test
    void comment_likes_share_30_per_minute_limit_with_post_likes() throws Exception {
        Post post = f.publishedPost("Like post and comment repeatedly");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID comment = f.createdId(f.create(an, post, "Comment liked and unliked repeatedly"));

        for (int i = 0; i < 15; i++) {
            f.likePost(binh, post, i % 2 == 0).andExpect(status().isOk());
        }
        for (int i = 0; i < 15; i++) {
            f.likeComment(binh, comment, i % 2 == 0).andExpect(status().isOk());
        }
        f.assertError(f.likeComment(binh, comment, false), 429, "RATE_LIMITED");
        f.assertError(f.likeComment(binh, comment, true), 429, "RATE_LIMITED");
        f.assertError(f.likePost(binh, post, false), 429, "RATE_LIMITED");

        // The blocked attempt writes nothing (the last accepted one was a like); other users are unaffected.
        assertThat(rows(comment)).isEqualTo(1);
        assertState(f.data(f.likeComment(an, comment, true).andExpect(status().isOk())), true, 2);
    }

    // --- Helpers ---------------------------------------------------------------------------------------

    private HeldTransaction hold(Consumer<JdbcTemplate> work) throws Exception {
        return new HeldTransaction(transactionManager, jdbcTemplate, work);
    }

    private long rows(UUID commentId) {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM comment_likes WHERE comment_id = ?", Long.class, commentId);
    }

    /** likeCount and likedByMe of a root comment on the first page, read as this user (null means anonymous). */
    private void assertLikes(Post post, Reader viewer, UUID rootId, long count, boolean likedByMe) throws Exception {
        JsonNode page = f.data(f.list(post, viewer == null ? null : viewer.bearer(), "size", "20")
                .andExpect(status().isOk()));
        JsonNode comment = thread(page, rootId).path("comment");
        String who = viewer == null ? "anonymous" : viewer.login();
        assertThat(comment.path("likeCount").asLong())
                .as("likeCount with %s", who)
                .isEqualTo(count);
        assertThat(comment.path("likedByMe").asBoolean())
                .as("likedByMe with %s", who)
                .isEqualTo(likedByMe);
    }

    private static void assertEditedAtMatchesEdited(JsonNode comment) {
        assertThat(comment.path("editedAt").isNull())
                .as("editedAt of %s", comment)
                .isEqualTo(!comment.path("edited").asBoolean());
    }

    private static void assertState(JsonNode state, boolean liked, long count) {
        assertThat(state.path("liked").asBoolean()).as("liked: %s", state).isEqualTo(liked);
        assertThat(state.path("count").asLong()).as("count: %s", state).isEqualTo(count);
    }
}
