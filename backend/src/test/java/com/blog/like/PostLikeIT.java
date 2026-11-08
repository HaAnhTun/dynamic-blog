package com.blog.like;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.comment.CommentFixtures;
import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.like.dto.LikeResponse;
import com.blog.like.repository.PostLikeRepository;
import com.blog.like.service.PostLikeService;
import com.blog.notification.repository.NotificationRepository;
import com.blog.notification.service.NotificationWriter;
import com.blog.post.repository.PostRepository;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.HeldTransaction;
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
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Post likes: {@code GET/PUT/DELETE /api/v1/posts/{slug}/like}. Like and unlike
 * are both idempotent and return the server state; only published posts accept likes; the DB blocks
 * duplicates (primary key plus {@code ON CONFLICT DO NOTHING}), so pressing many times at once still gives
 * exactly one row.
 *
 * Each test creates its own fresh reader: the limit of 30 likes and unlikes per minute per person lives in
 * the memory of the shared context. Suspended users are in UserSuspensionIT.
 */
@AutoConfigureMockMvc
class PostLikeIT extends AbstractIntegrationTest {

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
    private PostLikeRepository postLikeRepository;

    @Autowired
    private PostRepository postRepository;

    @Autowired
    private CurrentUserService currentUserService;

    @Autowired
    private RateLimiter rateLimiter;

    @Autowired
    private NotificationRepository notificationRepository;

    private CommentFixtures f;

    @BeforeEach
    void setUp() {
        f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
    }

    @Test
    void like_relike_unlike_reunlike_all_200_with_server_state_and_count() throws Exception {
        Post post = f.publishedPost("Liked post");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");

        MockHttpServletResponse anonymous =
                like(null, post, "GET").andExpect(status().isOk()).andReturn().getResponse();
        JsonNode nobody = objectMapper.readTree(anonymous.getContentAsString()).path("data");
        assertThat(nobody.propertyNames()).containsExactlyInAnyOrder("liked", "count");
        assertState(nobody, false, 0);

        assertState(f.data(like(an, post, "PUT").andExpect(status().isOk())), true, 1);
        // Like again: still one like, still 200.
        assertState(f.data(like(an, post, "PUT").andExpect(status().isOk())), true, 1);
        assertThat(rows(post)).isEqualTo(1);
        assertState(f.data(like(binh, post, "PUT").andExpect(status().isOk())), true, 2);

        // Each person sees their own like; a user who is not logged in sees the count.
        assertState(f.data(like(an, post, "GET").andExpect(status().isOk())), true, 2);
        assertState(f.data(like(binh, post, "GET").andExpect(status().isOk())), true, 2);
        assertState(f.data(like(null, post, "GET").andExpect(status().isOk())), false, 2);

        assertState(f.data(like(an, post, "DELETE").andExpect(status().isOk())), false, 1);
        // Unlike again: still 200.
        assertState(f.data(like(an, post, "DELETE").andExpect(status().isOk())), false, 1);
        assertState(f.data(like(an, post, "GET").andExpect(status().isOk())), false, 1);
        assertThat(rows(post)).isEqualTo(1);

        // Never reveals who liked.
        String body = like(null, post, "GET").andReturn().getResponse().getContentAsString();
        assertThat(body).doesNotContain(binh.id().toString()).doesNotContain(binh.login());
    }

    @Test
    void anonymous_can_read_likes_but_cannot_like() throws Exception {
        Post post = f.publishedPost("Like when not signed in");

        f.assertError(like(null, post, "PUT"), 401, "UNAUTHENTICATED");
        f.assertError(like(null, post, "DELETE"), 401, "UNAUTHENTICATED");

        assertThat(rows(post)).isZero();
        assertState(f.data(like(null, post, "GET").andExpect(status().isOk())), false, 0);
    }

    @Test
    void draft_unpublished_archived_or_missing_post_is_404_for_every_method() throws Exception {
        Reader an = f.reader("an");
        Post draft = f.draftPost("Draft takes no likes");
        Post unpublished = f.publishedPost("Post to be unpublished");
        Post archived = f.publishedPost("Post to be archived");
        like(an, unpublished, "PUT").andExpect(status().isOk());
        f.unpublish(unpublished);
        f.archive(archived);
        Post unknown = new Post(null, "khong-co-bai-nay-" + f.suffix);

        for (Post post : List.of(draft, unpublished, archived, unknown)) {
            for (String method : List.of("GET", "PUT", "DELETE")) {
                f.assertError(like(an, post, method), 404, "POST_NOT_FOUND");
            }
            // The count is not exposed even to a user who is not logged in.
            f.assertError(like(null, post, "GET"), 404, "POST_NOT_FOUND");
        }
        assertThat(rows(draft)).isZero();
        assertThat(rows(archived)).isZero();
        // A like from before the unpublish remains, and shows again when the post is republished.
        assertThat(rows(unpublished)).isEqualTo(1);
        f.republish(unpublished);
        assertState(f.data(like(an, unpublished, "GET").andExpect(status().isOk())), true, 1);
    }

    @Test
    void twenty_simultaneous_likes_give_exactly_one_row_all_200_and_no_error_in_log() throws Exception {
        Post post = f.publishedPost("Like repeatedly");
        Reader an = f.reader("an");
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
                    return like(an, post, "PUT").andReturn().getResponse();
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
        assertThat(rows(post)).isEqualTo(1);
        // Only the like that really inserted notifies the post author: exactly one notification.
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM notifications WHERE post_id = ?", Long.class, post.id()))
                .isEqualTo(1);
        assertThat(logs.list)
                .as("no duplicate-key error or any other error")
                .noneMatch(event -> event.getLevel().isGreaterOrEqual(Level.ERROR));
    }

    @Test
    void post_unpublished_just_before_like_insert_returns_404_not_liked() throws Exception {
        Post post = f.publishedPost("Unpublish during a like");
        Reader an = f.reader("an");

        ExecutorService pool = Executors.newSingleThreadExecutor();
        // Lock the post_likes table (SHARE: readable, not writable): the like has finished the "post is
        // published" check, so it must stop at the INSERT. The post is unpublished and committed meanwhile;
        // the INSERT then runs with a fresh snapshot and selects no post, 0 rows, and this user has no like:
        // 404, not "liked".
        try (HeldTransaction gate = new HeldTransaction(
                transactionManager, jdbcTemplate, jdbc -> jdbc.execute("LOCK TABLE post_likes IN SHARE MODE"))) {
            Future<MockHttpServletResponse> liking =
                    pool.submit(() -> like(an, post, "PUT").andReturn().getResponse());
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "INSERT INTO post_likes", 1);
            f.unpublish(post);
            gate.commit();

            f.assertError(liking.get(30, TimeUnit.SECONDS), 404, "POST_NOT_FOUND");
        } finally {
            pool.shutdownNow();
        }

        assertThat(rows(post)).isZero();
    }

    @Test
    void old_like_removed_from_other_tab_right_after_insert_is_liked_again_not_404() throws Exception {
        Post post = f.publishedPost("Like and unlike from two tabs");
        Reader an = f.reader("an");
        like(an, post, "PUT").andExpect(status().isOk());
        // The first like notified the post author (seeded admin). The author deletes that notification: the
        // re-insert in the branch below is a new like, so it must notify again exactly once.
        assertThat(jdbcTemplate.update(
                        "DELETE FROM notifications WHERE actor_id = ? AND post_id = ?", an.id(), post.id()))
                .isEqualTo(1);

        // The window is only a few SQL statements long, so PostLikeService is built by hand with a wrapped
        // PostLikeRepository: the INSERT hits the old like and adds nothing (ON CONFLICT DO NOTHING, does not
        // lock that row); right before the first re-read, the other tab unlikes and commits, on another
        // thread, outside the transaction of the like.
        AtomicBoolean unlikedElsewhere = new AtomicBoolean();
        ExecutorService otherTab = Executors.newSingleThreadExecutor();
        PostLikeRepository racing = (PostLikeRepository) Proxy.newProxyInstance(
                PostLikeRepository.class.getClassLoader(),
                new Class<?>[] {PostLikeRepository.class},
                (proxy, method, args) -> {
                    if (method.getName().equals("existsById") && unlikedElsewhere.compareAndSet(false, true)) {
                        otherTab.submit(() -> jdbcTemplate.update(
                                        "DELETE FROM post_likes WHERE post_id = ? AND user_id = ?", post.id(), an.id()))
                                .get(30, TimeUnit.SECONDS);
                    }
                    try {
                        return method.invoke(postLikeRepository, args);
                    } catch (InvocationTargetException e) {
                        throw e.getCause();
                    }
                });
        AtomicInteger notified = new AtomicInteger();
        NotificationWriter countingWriter = new NotificationWriter(notificationRepository) {
            @Override
            public void postLiked(UUID actorId, UUID postId) {
                notified.incrementAndGet();
                super.postLiked(actorId, postId);
            }
        };
        PostLikeService service =
                new PostLikeService(racing, postRepository, currentUserService, rateLimiter, countingWriter);

        LikeResponse response;
        try {
            SecurityContextHolder.getContext()
                    .setAuthentication(new JwtAuthenticationToken(Jwt.withTokenValue("token")
                            .header("alg", "HS256")
                            .subject(an.id().toString())
                            .claim("role", "USER")
                            .build()));
            response = new TransactionTemplate(transactionManager).execute(tx -> service.like(post.slug()));
        } finally {
            SecurityContextHolder.clearContext();
            otherTab.shutdownNow();
        }

        assertThat(unlikedElsewhere).isTrue();
        // The post is still published so this is not "post just unpublished": the like adds the like again,
        // as if it came after the unlike, and reports exactly what the DB holds.
        assertThat(response).isEqualTo(new LikeResponse(true, 1));
        assertThat(rows(post)).isEqualTo(1);
        // The first INSERT (hitting the old like) does not notify; the re-insert notifies exactly once.
        assertThat(notified).hasValue(1);
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM notifications WHERE actor_id = ? AND post_id = ? "
                                + "AND type = 'POST_LIKED'",
                        Long.class,
                        an.id(),
                        post.id()))
                .isEqualTo(1);
    }

    @Test
    void deleting_a_post_deletes_all_its_likes() throws Exception {
        Post post = f.publishedPost("Post to be deleted");
        like(f.reader("an"), post, "PUT").andExpect(status().isOk());
        like(f.reader("binh"), post, "PUT").andExpect(status().isOk());
        assertThat(rows(post)).isEqualTo(2);

        f.deletePost(post);

        assertThat(rows(post)).isZero();
    }

    @Test
    void like_and_unlike_share_30_per_minute_limit_per_user() throws Exception {
        Post post = f.publishedPost("Like and unlike repeatedly");
        Reader an = f.reader("an");
        Reader binh = f.reader("binh");

        for (int i = 0; i < 30; i++) {
            like(an, post, i % 2 == 0 ? "PUT" : "DELETE").andExpect(status().isOk());
        }
        f.assertError(like(an, post, "PUT"), 429, "RATE_LIMITED");
        f.assertError(like(an, post, "DELETE"), 429, "RATE_LIMITED");

        // The blocked attempt writes nothing; reads are not limited; other users are unaffected.
        assertState(f.data(like(an, post, "GET").andExpect(status().isOk())), false, 0);
        assertState(f.data(like(binh, post, "PUT").andExpect(status().isOk())), true, 1);
    }

    // --- Helpers ---------------------------------------------------------------------------------------

    /** {@code GET}, {@code PUT} (like) or {@code DELETE} (unlike); a null {@code reader} means not logged in. */
    private ResultActions like(Reader reader, Post post, String method) throws Exception {
        String path = "/api/v1/posts/" + post.slug() + "/like";
        MockHttpServletRequestBuilder request = switch (method) {
            case "PUT" -> put(path);
            case "DELETE" -> delete(path);
            default -> get(path);
        };
        if (reader != null) {
            request.header("Authorization", reader.bearer());
        }
        return mockMvc.perform(request);
    }

    private long rows(Post post) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM post_likes WHERE post_id = ?", Long.class, post.id());
    }

    private static void assertState(JsonNode state, boolean liked, long count) {
        assertThat(state.path("liked").asBoolean()).as("liked: %s", state).isEqualTo(liked);
        assertThat(state.path("count").asLong()).as("count: %s", state).isEqualTo(count);
    }
}
