package com.blog.notification;

import static com.blog.comment.CommentFixtures.notificationIds;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.tuple;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.comment.CommentFixtures;
import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.notification.repository.NotificationRepository;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.HeldTransaction;
import com.blog.user.entity.UserStatus;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Notifications: who is notified and when, what hides or shows a notification again, and {@code
 * /api/v1/notifications} (keyset list, unread count, mark as read, delete), only on the notifications of the
 * caller.
 *
 * The post that receives notifications is a post of an author created for each test ({@link
 * CommentFixtures#author}), not of the seeded admin: every like and comment of every IT on the posts of the
 * seeded admin piles into the admin inbox, while the inbox of a dedicated author only holds what that test
 * causes. Each test creates its own fresh reader (rate limit per person, in the memory of the shared
 * context). Notifications that need a specific time (keyset pages, cap at 100) are written straight with SQL.
 */
@AutoConfigureMockMvc
class NotificationIT extends AbstractIntegrationTest {

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
    private NotificationRepository notificationRepository;

    private CommentFixtures f;

    @BeforeEach
    void setUp() {
        f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
    }

    // --- Who is notified -------------------------------------------------------------------------------

    @Test
    void four_notification_types_reach_the_right_recipient_from_the_right_actor_with_comment_and_excerpt()
            throws Exception {
        Reader author = f.author("tac-gia");
        Post post = f.publishedPostBy(author.bearer(), "Post receiving all four notification kinds");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");

        f.likePost(an, post, true).andExpect(status().isOk());
        UUID root = f.createdId(f.create(an, post, "Root comment by An"));
        UUID reply = f.createdId(f.reply(binh, root, "Reply by Ben,\n\nvery long: " + "x".repeat(200)));
        f.likeComment(binh, root, true).andExpect(status().isOk());

        // The post author: post like, root comment, and reply (also a comment on their own post); newest
        // first.
        List<JsonNode> forAuthor = items(f.inbox(author));
        assertThat(forAuthor).hasSize(3);
        assertItem(forAuthor.get(0), "POST_COMMENTED", binh, post, reply);
        assertItem(forAuthor.get(1), "POST_COMMENTED", an, post, root);
        assertItem(forAuthor.get(2), "POST_LIKED", an, post, null);
        assertThat(forAuthor.get(1).path("excerpt").asString()).isEqualTo("Root comment by An");
        assertThat(forAuthor.get(2).path("excerpt").isNull()).isTrue();
        // The excerpt of the long reply: one line, whitespace collapsed, cut at 120 code points then an
        // ellipsis added.
        String excerpt = forAuthor.get(0).path("excerpt").asString();
        assertThat(excerpt)
                .startsWith("Reply by Ben, very long: xxx")
                .endsWith("x" + ELLIPSIS)
                .doesNotContain("\n");
        assertThat(excerpt.codePointCount(0, excerpt.length())).isEqualTo(121);

        // An, the writer of the root comment: gets a reply and a like; the excerpt of the like is An's own
        // comment.
        List<JsonNode> forAn = items(f.inbox(an));
        assertThat(forAn).hasSize(2);
        assertItem(forAn.get(0), "COMMENT_LIKED", binh, post, root);
        assertThat(forAn.get(0).path("excerpt").asString()).isEqualTo("Root comment by An");
        assertItem(forAn.get(1), "COMMENT_REPLIED", binh, post, reply);
        assertThat(forAn.get(1).path("excerpt").asString()).isEqualTo(excerpt);

        // Binh only causes, receives nothing.
        assertThat(items(f.inbox(binh))).isEmpty();
        assertThat(f.unreadCount(author)).isEqualTo(3);
        assertThat(f.unreadCount(an)).isEqualTo(2);
        assertThat(f.unreadCount(binh)).isZero();

        // Exactly five rows in the DB, recipient and actor as above.
        assertThat(jdbcTemplate.query(
                        "SELECT recipient_id, actor_id, type, comment_id FROM notifications WHERE post_id = ?",
                        (rs, row) -> tuple(
                                rs.getObject("recipient_id", UUID.class),
                                rs.getObject("actor_id", UUID.class),
                                rs.getString("type"),
                                rs.getObject("comment_id", UUID.class)),
                        post.id()))
                .containsExactlyInAnyOrder(
                        tuple(author.id(), an.id(), "POST_LIKED", null),
                        tuple(author.id(), an.id(), "POST_COMMENTED", root),
                        tuple(author.id(), binh.id(), "POST_COMMENTED", reply),
                        tuple(an.id(), binh.id(), "COMMENT_REPLIED", reply),
                        tuple(an.id(), binh.id(), "COMMENT_LIKED", root));
    }

    @Test
    void never_notifies_self_when_liking_or_commenting_on_own_post_replying_or_liking_own_comment() throws Exception {
        Reader author = f.author("tu-bao");
        Post post = f.publishedPostBy(author.bearer(), "Post that does not notify itself");
        Reader an = f.reader("an");

        f.likePost(author, post, true).andExpect(status().isOk());
        UUID own = f.createdId(f.create(author, post, "Author comments on own post"));
        f.likeComment(author, own, true).andExpect(status().isOk());
        UUID anRoot = f.createdId(f.create(an, post, "Comment by An"));
        UUID anSelfReply = f.createdId(f.reply(an, anRoot, "An replies to self"));
        f.likeComment(an, anRoot, true).andExpect(status().isOk());

        // An receives nothing from themselves. The author only receives the two comments of An: a self-reply
        // is still a comment on the post of the author.
        assertThat(items(f.inbox(an))).isEmpty();
        assertThat(items(f.inbox(author)))
                .extracting(item -> item.path("type").asString(), this::commentIdOf)
                .containsExactly(tuple("POST_COMMENTED", anSelfReply), tuple("POST_COMMENTED", anRoot));
        assertThat(f.countNotifications("post_id = ?", post.id())).isEqualTo(2);
        assertThat(f.countNotifications("post_id = ? AND actor_id = ?", post.id(), author.id()))
                .isZero();
    }

    @Test
    void reply_to_post_author_comment_or_written_by_post_author_yields_only_one_COMMENT_REPLIED() throws Exception {
        Reader author = f.author("tra-loi");
        Post post = f.publishedPostBy(author.bearer(), "Post whose author joins the discussion");
        Reader an = f.reader("an");

        UUID authorRoot = f.createdId(f.create(author, post, "Author starts the discussion"));
        UUID anReply = f.createdId(f.reply(an, authorRoot, "An replies to the author"));
        UUID anRoot = f.createdId(f.create(an, post, "Root comment by An"));
        UUID authorReply = f.createdId(f.reply(author, anRoot, "Author replies to An"));

        // A reply to the comment of the post author: COMMENT_REPLIED is enough, no POST_COMMENTED added for
        // the same reply.
        assertThat(items(f.inbox(author)))
                .extracting(item -> item.path("type").asString(), this::commentIdOf)
                .containsExactly(tuple("POST_COMMENTED", anRoot), tuple("COMMENT_REPLIED", anReply));
        // A reply written by the post author: only An is notified. Password-only account: login and avatar
        // are null.
        List<JsonNode> forAn = items(f.inbox(an));
        assertThat(forAn).hasSize(1);
        assertItem(forAn.getFirst(), "COMMENT_REPLIED", author, post, authorReply);
        assertThat(f.countNotifications("comment_id = ?", anReply)).isEqualTo(1);
        assertThat(f.countNotifications("comment_id = ?", authorReply)).isEqualTo(1);
    }

    @Test
    void unpublished_post_creates_no_notification_even_when_calling_the_insert_directly() throws Exception {
        Reader author = f.author("da-go");
        Post post = f.publishedPostBy(author.bearer(), "Post to be unpublished before being liked");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID comment = f.createdId(f.create(an, post, "Comment before the post is unpublished"));
        f.unpublish(post);

        f.assertError(f.likePost(binh, post, true), 404, "POST_NOT_FOUND");
        f.assertError(f.create(binh, post, "Comment on an unpublished post"), 404, "POST_NOT_FOUND");
        f.assertError(f.reply(binh, comment, "Reply on an unpublished post"), 404, "COMMENT_NOT_FOUND");
        f.assertError(f.likeComment(binh, comment, true), 404, "COMMENT_NOT_FOUND");
        assertThat(f.countNotifications("post_id = ? AND actor_id = ?", post.id(), binh.id()))
                .isZero();

        // The "post is published" condition is inside all four insert statements, not only in the check of
        // the service. The reply of Binh is written straight with SQL (like a reply just added when the post
        // is unpublished right after), so it notifies nothing by itself.
        UUID reply = f.insertComment(
                post, binh.id(), comment, "Reply written straight to an unpublished post", "VISIBLE", Instant.now());
        assertThat(notifyDirectly(binh, post, comment, reply)).containsExactly(0, 0, 0, 0);
        assertThat(f.countNotifications("post_id = ? AND actor_id = ?", post.id(), binh.id()))
                .isZero();
        // A notification from before the unpublish is hidden.
        assertThat(items(f.inbox(author))).isEmpty();
        assertThat(f.unreadCount(author)).isZero();

        // Control: republishing alone is enough for exactly those four statements to insert, so the zeros
        // above come from the post condition.
        f.republish(post);
        assertThat(notifyDirectly(binh, post, comment, reply)).containsExactly(1, 1, 1, 1);
        assertThat(f.countNotifications("post_id = ? AND actor_id = ?", post.id(), binh.id()))
                .isEqualTo(4);
    }

    @Test
    void rejected_submissions_409_422_429_create_no_notification() throws Exception {
        Reader author = f.author("tu-choi");
        Post post = f.publishedPostBy(author.bearer(), "Post receiving rejected submissions");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");

        // 409: same content the second time.
        f.createdId(f.create(an, post, "Comment submitted only once"));
        f.assertError(f.create(an, post, "Comment submitted only once"), 409, "COMMENT_DUPLICATE");
        // 422: the root already has 30 replies (written straight with SQL, so they create no notification
        // themselves).
        Instant base = Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.SECONDS);
        UUID full = f.insertComment(post, an.id(), null, "Root with enough replies", "VISIBLE", base);
        for (int i = 0; i < 30; i++) {
            f.insertComment(post, an.id(), full, "Reply number " + i, "VISIBLE", base.plusSeconds(i + 1L));
        }
        f.assertError(f.reply(binh, full, "Thirty-first reply"), 422, "COMMENT_NOT_REPLYABLE");
        // 429: the 422 above was already counted (the limit is checked first), so this is the sixth in a
        // minute for Binh.
        for (int i = 1; i <= 4; i++) {
            f.createdId(f.create(binh, post, "Comment number " + i + " by Ben"));
        }
        f.assertError(f.create(binh, post, "Sixth comment by Ben"), 429, "RATE_LIMITED");

        // Only the five comments that were really inserted notify the post author.
        assertThat(f.countNotifications("post_id = ?", post.id())).isEqualTo(5);
        assertThat(f.countNotifications("post_id = ? AND actor_id = ?", post.id(), an.id()))
                .isEqualTo(1);
        assertThat(f.countNotifications("post_id = ? AND actor_id = ?", post.id(), binh.id()))
                .isEqualTo(4);
        assertThat(f.countNotifications("comment_id IN (SELECT id FROM comments WHERE parent_id = ?)", full))
                .isZero();
    }

    @Test
    void post_unpublished_just_before_comment_insert_is_404_and_no_notification() throws Exception {
        Reader author = f.author("go-giua-chung");
        Post post = f.publishedPostBy(author.bearer(), "Post unpublished during a comment");
        Reader an = f.reader("an");

        ExecutorService pool = Executors.newSingleThreadExecutor();
        // As in CommentConcurrencyIT: the create stops at the comment insert, the post is unpublished and
        // committed meanwhile, the insert selects no post. The create throws 404 before reaching
        // NotificationWriter.
        try (HeldTransaction gate = new HeldTransaction(
                transactionManager, jdbcTemplate, jdbc -> jdbc.execute("LOCK TABLE comments IN SHARE MODE"))) {
            Future<MockHttpServletResponse> creating =
                    pool.submit(() -> f.create(an, post, "Comment just as the post is unpublished")
                            .andReturn()
                            .getResponse());
            HeldTransaction.awaitWaitingOnLock(
                    jdbcTemplate, "INSERT INTO comments (id, post_id, user_id, parent_id, content, created_at", 1);
            f.unpublish(post);
            gate.commit();

            f.assertError(creating.get(30, TimeUnit.SECONDS), 404, "POST_NOT_FOUND");
        } finally {
            pool.shutdownNow();
        }

        assertThat(f.countComments("post_id = ?", post.id())).isZero();
        assertThat(f.countNotifications("post_id = ?", post.id())).isZero();
    }

    @Test
    void ten_simultaneous_post_likes_by_one_user_give_one_notification() throws Exception {
        Reader author = f.author("thich-cung-luc");
        Post post = f.publishedPostBy(author.bearer(), "Post liked repeatedly");
        Reader an = f.reader("an");
        int calls = 10;

        CountDownLatch go = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(calls);
        List<MockHttpServletResponse> responses = new ArrayList<>();
        try {
            List<Future<MockHttpServletResponse>> futures = new ArrayList<>();
            for (int i = 0; i < calls; i++) {
                futures.add(pool.submit(() -> {
                    go.await();
                    return f.likePost(an, post, true).andReturn().getResponse();
                }));
            }
            go.countDown();
            for (Future<MockHttpServletResponse> future : futures) {
                responses.add(future.get(60, TimeUnit.SECONDS));
            }
        } finally {
            pool.shutdownNow();
        }

        assertThat(responses)
                .allSatisfy(response -> assertThat(response.getStatus()).isEqualTo(200));
        assertThat(f.countNotifications("post_id = ? AND type = 'POST_LIKED'", post.id()))
                .isEqualTo(1);
        assertThat(f.unreadCount(author)).isEqualTo(1);
    }

    // --- Hidden on read, not deleted --------------------------------------------------------------------

    @Test
    void like_unlike_relike_keeps_one_row_with_old_time_and_read_state_and_hidden_while_unliked() throws Exception {
        Reader author = f.author("thich-lai");
        Post post = f.publishedPostBy(author.bearer(), "Post liked, unliked, liked again");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID comment = f.createdId(f.create(an, post, "Comment liked, unliked, liked again"));
        // The comment of An already notified the author: mark as read so only the like notification below
        // remains.
        f.markAllRead(author, null).andExpect(status().isOk());

        f.likePost(binh, post, true).andExpect(status().isOk());
        JsonNode liked = items(f.inbox(author)).getFirst();
        UUID postLikeId = UUID.fromString(liked.path("id").asString());
        assertThat(liked.path("type").asString()).isEqualTo("POST_LIKED");
        f.markRead(author, postLikeId).andExpect(status().isOk());
        Map<String, Object> before = notificationRow(postLikeId);

        // Unlike: the row stays, but is hidden from the list.
        f.likePost(binh, post, false).andExpect(status().isOk());
        assertThat(notificationIds(f.inbox(author))).doesNotContain(postLikeId);
        assertThat(f.countNotifications("id = ?", postLikeId)).isEqualTo(1);
        // Like again: exactly the same row, same creation time, still read. No unread notification comes back
        // to life.
        f.likePost(binh, post, true).andExpect(status().isOk());
        assertThat(f.countNotifications("post_id = ? AND type = 'POST_LIKED'", post.id()))
                .isEqualTo(1);
        assertThat(notificationRow(postLikeId)).isEqualTo(before);
        JsonNode back = items(f.inbox(author)).getFirst();
        assertThat(back.path("id").asString()).isEqualTo(postLikeId.toString());
        assertThat(back.path("read").asBoolean()).isTrue();
        assertThat(back.path("createdAt").asString())
                .isEqualTo(liked.path("createdAt").asString());
        assertThat(f.unreadCount(author)).isZero();

        // Comment like: the same, with a notification that is still unread.
        f.likeComment(binh, comment, true).andExpect(status().isOk());
        UUID commentLikeId = notificationIds(f.inbox(an)).getFirst();
        Map<String, Object> unreadBefore = notificationRow(commentLikeId);
        assertThat(f.unreadCount(an)).isEqualTo(1);
        f.likeComment(binh, comment, false).andExpect(status().isOk());
        assertThat(notificationIds(f.inbox(an))).isEmpty();
        assertThat(f.unreadCount(an)).isZero();
        f.likeComment(binh, comment, true).andExpect(status().isOk());
        assertThat(notificationIds(f.inbox(an))).containsExactly(commentLikeId);
        assertThat(notificationRow(commentLikeId)).isEqualTo(unreadBefore);
        assertThat(f.unreadCount(an)).isEqualTo(1);
    }

    @Test
    void hidden_or_deleted_comment_notification_leaves_list_and_count_and_returns_when_restored() throws Exception {
        Reader author = f.author("an-hien");
        Post post = f.publishedPostBy(author.bearer(), "Post with a moderated comment");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID root = f.createdId(f.create(an, post, "Comment to be hidden then unhidden"));
        f.likeComment(binh, root, true).andExpect(status().isOk());
        UUID reply = f.createdId(f.reply(binh, root, "Reply to be deleted"));
        assertThat(commentIds(author)).containsExactly(reply, root);
        assertThat(commentIds(an)).containsExactly(reply, root);

        // Hide the root: the notifications about that comment hide with it (the comment of An for the author,
        // the like on it for An). The reply still shows under the placeholder, so the notification of the
        // reply remains.
        f.moderate(root, "HIDDEN").andExpect(status().isOk());
        assertThat(commentIds(author)).containsExactly(reply);
        assertThat(commentIds(an)).containsExactly(reply);
        assertThat(f.unreadCount(author)).isEqualTo(1);
        assertThat(f.unreadCount(an)).isEqualTo(1);

        // Unhide: they come back, unread as before.
        f.moderate(root, "VISIBLE").andExpect(status().isOk());
        assertThat(commentIds(author)).containsExactly(reply, root);
        assertThat(commentIds(an)).containsExactly(reply, root);
        assertThat(f.unreadCount(author)).isEqualTo(2);

        // Binh deletes their own reply: its notification is hidden.
        f.remove(binh, reply).andExpect(status().isNoContent());
        assertThat(commentIds(author)).containsExactly(root);
        assertThat(commentIds(an)).containsExactly(root);
        assertThat(f.unreadCount(an)).isEqualTo(1);
        // No row is deleted: only filtered on read.
        assertThat(f.countNotifications("post_id = ?", post.id())).isEqualTo(4);
    }

    @Test
    void unpublished_post_hides_notification_republish_shows_it_hard_delete_cascades() throws Exception {
        Reader author = f.author("go-bai");
        Post post = f.publishedPostBy(author.bearer(), "Post to be unpublished, republished, then deleted");
        Reader an = f.reader("an");
        f.likePost(an, post, true).andExpect(status().isOk());
        f.createdId(f.create(an, post, "Comment on a post to be unpublished"));
        assertThat(items(f.inbox(author))).hasSize(2);

        f.unpublish(post);
        assertThat(items(f.inbox(author))).isEmpty();
        assertThat(f.unreadCount(author)).isZero();

        f.republish(post);
        assertThat(items(f.inbox(author))).hasSize(2);
        assertThat(f.unreadCount(author)).isEqualTo(2);

        f.deletePost(post);
        assertThat(f.countNotifications("post_id = ?", post.id())).isZero();
        assertThat(items(f.inbox(author))).isEmpty();
    }

    @Test
    void suspended_actor_notification_still_shows_suspended_recipient_gets_403_but_notification_is_still_created()
            throws Exception {
        Reader author = f.author("tam-khoa");
        Post post = f.publishedPostBy(author.bearer(), "Post whose commenter gets suspended");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        UUID anRoot = f.createdId(f.create(an, post, "Comment by a user to be suspended"));
        UUID notification = notificationIds(f.inbox(author)).getFirst();
        f.createdId(f.reply(binh, anRoot, "Reply before An is suspended"));

        auth.setStatus(an.id(), UserStatus.SUSPENDED);

        // The comment of the suspended user is still public, so the notification about it still shows.
        assertThat(commentIds(author)).contains(anRoot);
        // The notification inbox belongs to the account: the suspended user cannot read it and cannot change
        // anything.
        f.assertError(f.notifications(an), 403, "USER_SUSPENDED");
        f.assertError(
                mockMvc.perform(get("/api/v1/notifications/unread-count").header("Authorization", an.bearer())),
                403,
                "USER_SUSPENDED");
        UUID anNotification =
                jdbcTemplate.queryForObject("SELECT id FROM notifications WHERE recipient_id = ?", UUID.class, an.id());
        f.assertError(f.markRead(an, anNotification), 403, "USER_SUSPENDED");
        f.assertError(f.markAllRead(an, null), 403, "USER_SUSPENDED");
        f.assertError(f.deleteNotification(an, anNotification), 403, "USER_SUSPENDED");
        assertThat(notificationRow(anNotification).get("read_at")).isNull();
        // Still created for the suspended user: when unsuspended they see it.
        f.createdId(f.reply(binh, anRoot, "Reply while An is suspended"));
        assertThat(f.countNotifications("recipient_id = ?", an.id())).isEqualTo(2);
        auth.setStatus(an.id(), UserStatus.ACTIVE);
        assertThat(f.unreadCount(an)).isEqualTo(2);
        assertThat(notificationIds(f.inbox(author))).contains(notification);
    }

    // --- API -------------------------------------------------------------------------------------------

    @Test
    void
            keyset_page_newest_first_no_repeat_no_skip_with_new_notification_between_pages_and_headCursor_only_on_first_page()
                    throws Exception {
        Reader author = f.author("phan-trang");
        Post post = f.publishedPostBy(author.bearer(), "Post with many notifications");
        Reader an = f.reader("an");
        Instant base = Instant.now().minus(1, ChronoUnit.HOURS).truncatedTo(ChronoUnit.SECONDS);
        UUID comment = f.insertComment(post, an.id(), null, "Comment for the notification page", "VISIBLE", base);
        UUID n0 = notify(author, an, post, comment, base.plusSeconds(1));
        UUID n1 = notify(author, an, post, comment, base.plusSeconds(2));
        // Two notifications of the same instant (same transaction): ordered by id, larger first. The two ids
        // differ only in the last byte, so the Postgres order (byte by byte) and the Java order agree.
        UUID random = UUID.randomUUID();
        UUID tieLow = new UUID(random.getMostSignificantBits(), random.getLeastSignificantBits() & ~0xFFL | 0x01);
        UUID tieHigh = new UUID(random.getMostSignificantBits(), random.getLeastSignificantBits() & ~0xFFL | 0x02);
        f.insertNotification(tieLow, author.id(), an.id(), "POST_COMMENTED", post, comment, base.plusSeconds(3));
        f.insertNotification(tieHigh, author.id(), an.id(), "POST_COMMENTED", post, comment, base.plusSeconds(3));
        UUID n3 = notify(author, an, post, comment, base.plusSeconds(4));
        UUID n4 = notify(author, an, post, comment, base.plusSeconds(5));

        JsonNode first = f.data(f.notifications(author, "size", "2").andExpect(status().isOk()));
        assertThat(notificationIds(first)).containsExactly(n4, n3);
        assertThat(first.path("nextCursor").isString()).isTrue();
        assertThat(first.path("headCursor").isString()).isTrue();

        // A new notification arrives between the two loads: it is newer than the cursor, so the next page
        // neither repeats nor skips anything.
        UUID newest = notify(author, an, post, comment, base.plusSeconds(60));
        JsonNode second = f.data(f.notifications(
                        author, "size", "2", "after", first.path("nextCursor").asString())
                .andExpect(status().isOk()));
        assertThat(notificationIds(second)).containsExactly(tieHigh, tieLow);
        assertThat(second.path("headCursor").isNull()).isTrue();
        JsonNode third = f.data(f.notifications(
                        author, "size", "2", "after", second.path("nextCursor").asString())
                .andExpect(status().isOk()));
        assertThat(notificationIds(third)).containsExactly(n1, n0);
        assertThat(third.path("nextCursor").isNull()).isTrue();
        assertThat(third.path("headCursor").isNull()).isTrue();
        assertThat(f.data(f.notifications(author, "size", "2"))
                        .path("items")
                        .get(0)
                        .path("id")
                        .asString())
                .isEqualTo(newest.toString());

        // Unread filter, also by page.
        f.markRead(author, n4).andExpect(status().isOk());
        f.markRead(author, tieLow).andExpect(status().isOk());
        JsonNode unread =
                f.data(f.notifications(author, "unread", "true", "size", "50").andExpect(status().isOk()));
        assertThat(notificationIds(unread)).containsExactly(newest, n3, tieHigh, n1, n0);
        assertThat(unread.path("items"))
                .allSatisfy(item -> assertThat(item.path("read").asBoolean()).isFalse());
        List<UUID> paged = new ArrayList<>();
        String after = null;
        do {
            JsonNode page = after == null
                    ? f.data(f.notifications(author, "unread", "true", "size", "2"))
                    : f.data(f.notifications(author, "unread", "true", "size", "2", "after", after));
            paged.addAll(notificationIds(page));
            after = page.path("nextCursor").isNull()
                    ? null
                    : page.path("nextCursor").asString();
        } while (after != null);
        assertThat(paged).containsExactly(newest, n3, tieHigh, n1, n0);
        JsonNode all = f.inbox(author);
        assertThat(notificationIds(all)).containsExactly(newest, n4, n3, tieHigh, tieLow, n1, n0);

        // Empty inbox: no cursor at all.
        JsonNode empty = f.inbox(f.reader("trong"));
        assertThat(empty.path("items").isEmpty()).isTrue();
        assertThat(empty.path("nextCursor").isNull()).isTrue();
        assertThat(empty.path("headCursor").isNull()).isTrue();
    }

    @Test
    void unread_count_capped_at_100_while_list_stays_complete() throws Exception {
        Reader author = f.author("tram-thong-bao");
        Post post = f.publishedPostBy(author.bearer(), "Post with over a hundred notifications");
        Reader an = f.reader("an");
        UUID comment = f.insertComment(
                post,
                an.id(),
                null,
                "Comment notified many times",
                "VISIBLE",
                Instant.now().minus(1, ChronoUnit.HOURS));
        jdbcTemplate.update("""
                INSERT INTO notifications (recipient_id, actor_id, type, post_id, comment_id, created_at)
                SELECT ?, ?, 'POST_COMMENTED', ?, ?, now() - make_interval(secs => g)
                FROM generate_series(1, 105) g""", author.id(), an.id(), post.id(), comment);

        assertThat(f.unreadCount(author)).isEqualTo(100);
        Set<UUID> seen = new HashSet<>();
        JsonNode page = f.data(f.notifications(author, "size", "50"));
        seen.addAll(notificationIds(page));
        while (!page.path("nextCursor").isNull()) {
            page = f.data(f.notifications(
                    author, "size", "50", "after", page.path("nextCursor").asString()));
            seen.addAll(notificationIds(page));
        }
        assertThat(seen).hasSize(105);
        // Page size clamped to 1..50.
        assertThat(f.data(f.notifications(author, "size", "500")).path("items").size())
                .isEqualTo(50);
        assertThat(f.data(f.notifications(author, "size", "0")).path("items").size())
                .isEqualTo(1);
        assertThat(count(f.markAllRead(author, null))).isZero();
    }

    @Test
    void mark_read_mark_all_and_delete_all_return_new_unread_count() throws Exception {
        Reader author = f.author("da-doc");
        // The title avoids the word "read": PostSearchAndFeaturedIT searches that exact word on all published posts.
        Post post = f.publishedPostBy(author.bearer(), "Post to mark notifications on");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        f.likePost(an, post, true).andExpect(status().isOk());
        f.likePost(binh, post, true).andExpect(status().isOk());
        f.createdId(f.create(an, post, "Comment to mark as read"));
        JsonNode loaded = f.inbox(author);
        List<UUID> ids = notificationIds(loaded);
        assertThat(ids).hasSize(3);
        assertThat(f.unreadCount(author)).isEqualTo(3);

        // Open a notification: read; opening again is still 200 and changes nothing.
        assertThat(count(f.markRead(author, ids.get(1)))).isEqualTo(2);
        Object readAt = notificationRow(ids.get(1)).get("read_at");
        assertThat(readAt).isNotNull();
        assertThat(count(f.markRead(author, ids.get(1)))).isEqualTo(2);
        assertThat(notificationRow(ids.get(1)).get("read_at")).isEqualTo(readAt);
        assertThat(items(f.inbox(author)).get(1).path("read").asBoolean()).isTrue();

        // Delete an unread notification: the count drops; the second delete is 404.
        assertThat(count(f.deleteNotification(author, ids.get(2)))).isEqualTo(1);
        f.assertError(f.deleteNotification(author, ids.get(2)), 404, "NOTIFICATION_NOT_FOUND");
        assertThat(f.countNotifications("id = ?", ids.get(2))).isZero();

        // Mark all up to the headCursor of the loaded list: notifications that arrive later stay unread.
        UUID later = f.createdId(f.create(binh, post, "Comment arriving after the list was loaded"));
        assertThat(f.unreadCount(author)).isEqualTo(2);
        assertThat(count(f.markAllRead(author, loaded.path("headCursor").asString())))
                .isEqualTo(1);
        List<JsonNode> after = items(f.inbox(author));
        assertThat(after.getFirst().path("commentId").asString()).isEqualTo(later.toString());
        assertThat(after.getFirst().path("read").asBoolean()).isFalse();
        assertThat(after.subList(1, after.size()))
                .allSatisfy(item -> assertThat(item.path("read").asBoolean()).isTrue());

        // Malformed cursor: 400, nothing changes. No cursor: mark everything.
        f.assertError(f.markAllRead(author, "khong-phai-con-tro!"), 400, "VALIDATION_ERROR");
        assertThat(f.unreadCount(author)).isEqualTo(1);
        assertThat(count(f.markAllRead(author, null))).isZero();
        assertThat(count(f.markAllRead(author, null))).isZero();
    }

    @Test
    void notification_of_someone_else_is_404_while_malformed_id_cursor_page_size_or_filter_is_400() throws Exception {
        Reader author = f.author("rieng-tu");
        Post post = f.publishedPostBy(author.bearer(), "Post with private notifications");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");
        f.createdId(f.create(an, post, "Comment notifying the author"));
        UUID id = notificationIds(f.inbox(author)).getFirst();

        // Not 403: it does not reveal whether that notification exists.
        f.assertError(f.markRead(binh, id), 404, "NOTIFICATION_NOT_FOUND");
        f.assertError(f.deleteNotification(binh, id), 404, "NOTIFICATION_NOT_FOUND");
        f.assertError(f.markRead(author, UUID.randomUUID()), 404, "NOTIFICATION_NOT_FOUND");
        f.assertError(f.deleteNotification(author, UUID.randomUUID()), 404, "NOTIFICATION_NOT_FOUND");
        // Mark all of Binh does not touch the inbox of the author.
        f.markAllRead(binh, null).andExpect(status().isOk());
        assertThat(notificationRow(id).get("read_at")).isNull();
        assertThat(f.countNotifications("id = ?", id)).isEqualTo(1);
        assertThat(f.unreadCount(author)).isEqualTo(1);

        f.assertError(
                mockMvc.perform(
                        post("/api/v1/notifications/khong-phai-uuid/read").header("Authorization", author.bearer())),
                400,
                "VALIDATION_ERROR");
        f.assertError(
                mockMvc.perform(
                        delete("/api/v1/notifications/khong-phai-uuid").header("Authorization", author.bearer())),
                400,
                "VALIDATION_ERROR");
        f.assertError(f.notifications(author, "after", "khong-phai-con-tro!"), 400, "VALIDATION_ERROR");
        f.assertError(f.notifications(author, "size", "nhieu"), 400, "VALIDATION_ERROR");
        f.assertError(f.notifications(author, "unread", "co-le"), 400, "VALIDATION_ERROR");
        // Not logged in: 401 on every path.
        f.assertError(f.notifications(null), 401, "UNAUTHENTICATED");
        f.assertError(f.markRead(null, id), 401, "UNAUTHENTICATED");
    }

    @Test
    void notification_carries_only_the_contract_fields_no_user_id_email_role_or_status() throws Exception {
        Reader author = f.author("hop-dong");
        Post post = f.publishedPostBy(author.bearer(), "Post checking the notification fields");
        Reader an = f.reader("an");
        f.likePost(an, post, true).andExpect(status().isOk());
        f.createdId(f.create(an, post, "Comment checking the fields"));

        String body = f.notifications(author)
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        JsonNode page = objectMapper.readTree(body).path("data");
        assertThat(page.propertyNames()).containsExactlyInAnyOrder("items", "nextCursor", "headCursor");
        assertThat(page.path("items")).hasSize(2).allSatisfy(item -> {
            assertThat(item.propertyNames())
                    .containsExactlyInAnyOrder(
                            "id", "type", "createdAt", "read", "actor", "post", "commentId", "excerpt");
            assertThat(item.path("actor").propertyNames())
                    .containsExactlyInAnyOrder("displayName", "githubLogin", "avatarUrl");
            assertThat(item.path("post").propertyNames()).containsExactlyInAnyOrder("slug", "title");
        });
        assertThat(body)
                .doesNotContain(an.id().toString())
                .doesNotContain(author.id().toString())
                .doesNotContain(post.id().toString())
                .doesNotContain("@blog.local")
                .doesNotContain("\"USER\"")
                .doesNotContain("\"ACTIVE\"");
        JsonNode count = f.data(
                mockMvc.perform(get("/api/v1/notifications/unread-count").header("Authorization", author.bearer()))
                        .andExpect(status().isOk()));
        assertThat(count.propertyNames()).containsExactly("count");
    }

    @Test
    void failing_notification_insert_rolls_back_the_whole_like_or_comment_with_500() throws Exception {
        Reader author = f.author("hong");
        Post post = f.publishedPostBy(author.bearer(), "Post with a failing notification insert");
        Reader an = f.reader("an");
        UUID others = f.createdId(f.create(f.reader("binh"), post, "Comment for An to like"));
        // A trigger that only fails for this one user: other tests, even if it is left behind, never touch
        // it.
        String name = "test_hong_thong_bao_" + f.suffix;
        jdbcTemplate.execute("CREATE FUNCTION " + name + "() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
                + "IF NEW.actor_id = '" + an.id()
                + "' THEN RAISE EXCEPTION 'deliberately failing notification'; END IF; "
                + "RETURN NEW; END $$");
        jdbcTemplate.execute("CREATE TRIGGER " + name + " BEFORE INSERT ON notifications FOR EACH ROW "
                + "EXECUTE FUNCTION " + name + "()");
        try {
            f.assertError(f.likePost(an, post, true), 500, "INTERNAL_ERROR");
            f.assertError(f.create(an, post, "Comment to be rolled back"), 500, "INTERNAL_ERROR");
            f.assertError(f.likeComment(an, others, true), 500, "INTERNAL_ERROR");
        } finally {
            jdbcTemplate.execute("DROP TRIGGER IF EXISTS " + name + " ON notifications");
            jdbcTemplate.execute("DROP FUNCTION IF EXISTS " + name + "()");
        }

        // Same transaction: no like and no comment survives when its notification is not written.
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM post_likes WHERE user_id = ?", Long.class, an.id()))
                .isZero();
        assertThat(f.countComments("user_id = ?", an.id())).isZero();
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM comment_likes WHERE user_id = ?", Long.class, an.id()))
                .isZero();
        assertThat(f.countNotifications("actor_id = ?", an.id())).isZero();
        // When the DB is healthy again, that same like succeeds and notifies normally.
        f.likePost(an, post, true).andExpect(status().isOk());
        assertThat(f.countNotifications("actor_id = ?", an.id())).isEqualTo(1);
    }

    @Test
    void schema_blocks_self_notification_unknown_type_missing_or_extra_comment_and_duplicate_like_notification()
            throws Exception {
        Reader author = f.author("luoc-do");
        Post post = f.publishedPostBy(author.bearer(), "Post checking the notification schema");
        Reader an = f.reader("an");
        Instant now = Instant.now();
        UUID comment = f.insertComment(post, an.id(), null, "Comment checking the schema", "VISIBLE", now);

        assertThatThrownBy(() -> f.insertNotification(an.id(), an.id(), "POST_COMMENTED", post, comment, now))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("chk_notifications_not_self");
        assertThatThrownBy(() -> f.insertNotification(author.id(), an.id(), "POST_SHARED", post, comment, now))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("chk_notifications_type");
        assertThatThrownBy(() -> f.insertNotification(author.id(), an.id(), "POST_LIKED", post, comment, now))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("chk_notifications_comment");
        assertThatThrownBy(() -> f.insertNotification(author.id(), an.id(), "COMMENT_LIKED", post, null, now))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("chk_notifications_comment");

        // Like notification: at most one row per (recipient, liker, target).
        f.insertNotification(author.id(), an.id(), "POST_LIKED", post, null, now);
        assertThatThrownBy(() -> f.insertNotification(author.id(), an.id(), "POST_LIKED", post, null, now))
                .isInstanceOf(DuplicateKeyException.class)
                .hasMessageContaining("uq_notifications_post_liked");
        f.insertNotification(author.id(), an.id(), "COMMENT_LIKED", post, comment, now);
        assertThatThrownBy(() -> f.insertNotification(author.id(), an.id(), "COMMENT_LIKED", post, comment, now))
                .isInstanceOf(DuplicateKeyException.class)
                .hasMessageContaining("uq_notifications_comment_liked");
        // Post comment: one event per comment, no duplicate guard.
        f.insertNotification(author.id(), an.id(), "POST_COMMENTED", post, comment, now);
        f.insertNotification(author.id(), an.id(), "POST_COMMENTED", post, comment, now);
        assertThat(f.countNotifications("post_id = ?", post.id())).isEqualTo(4);
    }

    // --- Helpers ---------------------------------------------------------------------------------------

    private static final String ELLIPSIS = Character.toString(0x2026);

    private static List<JsonNode> items(JsonNode page) {
        List<JsonNode> items = new ArrayList<>();
        page.path("items").forEach(items::add);
        return items;
    }

    private UUID commentIdOf(JsonNode item) {
        return item.path("commentId").isNull()
                ? null
                : UUID.fromString(item.path("commentId").asString());
    }

    /** The comment of each notification currently visible to this user, newest first. */
    private List<UUID> commentIds(Reader reader) throws Exception {
        return items(f.inbox(reader)).stream().map(this::commentIdOf).toList();
    }

    private UUID notify(Reader recipient, Reader actor, Post post, UUID comment, Instant at) {
        return f.insertNotification(recipient.id(), actor.id(), "POST_COMMENTED", post, comment, at);
    }

    /**
     * Calls the four notification inserts directly, skipping every check of the service: post like, comment
     * like {@code liked}, and the two statements of the reply {@code reply}. Returns the number of rows each
     * insert added, in that order.
     */
    private List<Integer> notifyDirectly(Reader actor, Post post, UUID liked, UUID reply) {
        return new TransactionTemplate(transactionManager)
                .execute(status -> List.of(
                        notificationRepository.notifyPostLiked(actor.id(), post.id()),
                        notificationRepository.notifyCommentLiked(actor.id(), liked),
                        notificationRepository.notifyCommentReplied(reply),
                        notificationRepository.notifyPostCommented(reply)));
    }

    private Map<String, Object> notificationRow(UUID id) {
        return jdbcTemplate.queryForMap(
                "SELECT recipient_id, actor_id, type, created_at, read_at FROM notifications " + "WHERE id = ?", id);
    }

    private long count(ResultActions result) throws Exception {
        return f.data(result.andExpect(status().isOk())).path("count").asLong();
    }

    /** An unread notification of the right type, from the right actor (name, login, avatar), for the right post/comment. */
    private void assertItem(JsonNode item, String type, Reader actor, Post post, UUID commentId) {
        assertThat(item.path("type").asString()).as("type: %s", item).isEqualTo(type);
        assertThat(item.path("read").asBoolean()).as("read: %s", item).isFalse();
        Instant.parse(item.path("createdAt").asString());
        UUID.fromString(item.path("id").asString());
        JsonNode by = item.path("actor");
        assertThat(by.path("displayName").asString()).isEqualTo(actor.displayName());
        if (actor.login() == null) {
            assertThat(by.path("githubLogin").isNull()).isTrue();
            assertThat(by.path("avatarUrl").isNull()).isTrue();
        } else {
            assertThat(by.path("githubLogin").asString()).isEqualTo(actor.login());
            assertThat(by.path("avatarUrl").asString()).startsWith("https://avatars.githubusercontent.com/u/");
        }
        assertThat(item.path("post").path("slug").asString()).isEqualTo(post.slug());
        assertThat(item.path("post").path("title").asString())
                .isEqualTo(
                        jdbcTemplate.queryForObject("SELECT title FROM posts WHERE id = ?", String.class, post.id()));
        assertThat(commentIdOf(item)).as("commentId: %s", item).isEqualTo(commentId);
        if (commentId == null) {
            assertThat(item.path("excerpt").isNull()).isTrue();
        } else {
            assertThat(item.path("excerpt").isString()).isTrue();
        }
    }
}
