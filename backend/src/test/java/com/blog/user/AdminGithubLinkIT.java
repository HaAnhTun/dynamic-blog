package com.blog.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.tuple;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.auth.service.RefreshTokenService;
import com.blog.comment.CommentFixtures;
import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.common.security.AdminAccountProperties;
import com.blog.common.security.AdminGithubLink;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.GithubLoginFlow;
import com.blog.support.GithubStub;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Linking the admin account to GitHub at startup ({@code ADMIN_GITHUB_ID}).
 *
 * Each test runs the real runner on an ADMIN account of its own made for it, not the seeded admin: the seed row is shared by
 * the whole test suite (and was already linked to {@link GithubStub#ADMIN_GITHUB_ID} by the shared context), so a merge that fails halfway
 * here must not leave it in a strange state. GitHub ids come from {@link AuthTestSupport#nextGithubId()}.
 *
 * "Never break startup" is checked with the {@code run} call itself: it throws nothing in any case, even when the
 * DB refuses in the middle of the merge. The opposite case (a wrong value means no startup) needs no DB, so it lives in
 * {@code common/security/AdminGithubLinkStartupTest}: the nested {@code @Configuration} class that ApplicationContextRunner needs would
 * be picked up by Spring TestContext as the configuration of this very IT.
 */
@AutoConfigureMockMvc
class AdminGithubLinkIT extends AbstractIntegrationTest {

    private static final UUID SEEDED_ADMIN = UUID.fromString("00000000-0000-0000-0000-000000000001");

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private RefreshTokenService refreshTokenService;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JwtDecoder jwtDecoder;

    @Autowired
    private ObjectMapper objectMapper;

    private final Logger logger = (Logger) LoggerFactory.getLogger(AdminGithubLink.class);
    private ListAppender<ILoggingEvent> logs;
    private String suffix;

    @BeforeEach
    void setUp() {
        suffix = UUID.randomUUID().toString().substring(0, 8);
        logs = new ListAppender<>();
        logs.start();
        logger.addAppender(logs);
        GITHUB.reset();
    }

    @AfterEach
    void tearDown() {
        logger.detachAppender(logs);
        GITHUB.reset();
    }

    @Test
    void shared_context_linked_seed_admin_to_ADMIN_GITHUB_ID_at_startup() {
        assertThat(jdbcTemplate.queryForObject("SELECT github_id FROM users WHERE id = ?", Long.class, SEEDED_ADMIN))
                .isEqualTo(GithubStub.ADMIN_GITHUB_ID);
    }

    @Test
    void unused_id_links_and_running_again_changes_nothing_and_logs_nothing() {
        String email = adminEmail("lien-ket");
        UUID admin = auth.createAccount(email, UserRole.ADMIN).getId();
        long githubId = auth.nextGithubId();

        run(email, githubId);
        assertThat(githubIdOf(admin)).isEqualTo(githubId);
        assertThat(messages(Level.INFO)).singleElement().asString().contains("linked to GitHub id " + githubId);

        logs.list.clear();
        run(email, githubId);
        assertThat(githubIdOf(admin)).isEqualTo(githubId);
        assertThat(logs.list).isEmpty();
    }

    @Test
    void a_real_link_ends_the_sessions_of_the_admin_but_the_next_startup_leaves_new_ones_alone() throws Exception {
        String email = adminEmail("phien");
        User admin = auth.createAccount(email, UserRole.ADMIN);
        long githubId = auth.nextGithubId();
        String refreshBefore = auth.verifiedRefreshToken(admin);
        String accessBefore = auth.bearerIssuedAt(admin, Instant.now().minusSeconds(30));
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", accessBefore))
                .andExpect(status().isOk());

        run(email, githubId);

        // The admin gained a way in: every session opened before it is over, access token included.
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", accessBefore))
                .andExpect(status().isUnauthorized());
        assertThat(revoked(refreshBefore)).isTrue();

        // The next startup finds the link in place and does nothing: a session opened since survives.
        String refreshAfter = auth.verifiedRefreshToken(admin);
        Instant cutOff = tokensValidAfter(admin.getId());
        assertThat(cutOff).isNotNull();
        run(email, githubId);
        assertThat(tokensValidAfter(admin.getId())).isEqualTo(cutOff);
        assertThat(revoked(refreshAfter)).isFalse();
    }

    @Test
    void a_link_that_is_refused_ends_no_session() {
        String email = adminEmail("tu-choi");
        User admin = auth.createAccount(email, UserRole.ADMIN);
        User otherAdmin = auth.createAccount(adminEmail("khac"), UserRole.ADMIN);
        long githubId = auth.nextGithubId();
        jdbcTemplate.update("UPDATE users SET github_id = ? WHERE id = ?", githubId, otherAdmin.getId());
        String session = auth.verifiedRefreshToken(admin);

        run(email, githubId);

        assertThat(githubIdOf(admin.getId())).isNull();
        assertThat(tokensValidAfter(admin.getId())).isNull();
        assertThat(revoked(session)).isFalse();
    }

    @Test
    void id_of_a_reader_merges_comments_and_likes_into_admin_deletes_old_row_and_github_login_gives_ADMIN()
            throws Exception {
        String email = adminEmail("gop");
        User admin = auth.createAccount(email, UserRole.ADMIN);
        long githubId = auth.nextGithubId();
        User reader = auth.createReader(githubId, "chu-site-" + suffix);
        auth.verifiedRefreshToken(reader);
        UUID postA = insertDraftPost("gop-a");
        UUID postB = insertDraftPost("gop-b");
        UUID root = insertComment(postA, reader.getId(), null, "root comment from the reader");
        insertComment(postA, reader.getId(), root, "reply from the reader");
        like(postA, reader.getId());
        like(postB, reader.getId());
        // The admin already liked post A: the merge must not create a duplicate like.
        like(postA, admin.getId());
        // Bookmarks too, and they keep their saved time, the order of the saved list.
        OffsetDateTime savedAt = OffsetDateTime.parse("2026-01-02T03:04:05Z");
        bookmark(postA, reader.getId(), savedAt);
        bookmark(postB, reader.getId(), savedAt);
        bookmark(postA, admin.getId(), OffsetDateTime.now());

        assertThatCode(() -> run(email, githubId)).doesNotThrowAnyException();

        assertThat(count("SELECT count(*) FROM users WHERE id = ?", reader.getId()))
                .isZero();
        assertThat(count("SELECT count(*) FROM refresh_tokens WHERE user_id = ?", reader.getId()))
                .isZero();
        assertThat(count("SELECT count(*) FROM comments WHERE user_id = ?", admin.getId()))
                .isEqualTo(2);
        assertThat(jdbcTemplate.queryForList(
                        "SELECT post_id FROM post_likes WHERE user_id = ? ORDER BY post_id", UUID.class, admin.getId()))
                .containsExactlyInAnyOrder(postA, postB);
        assertThat(jdbcTemplate.queryForList(
                        "SELECT post_id FROM post_bookmarks WHERE user_id = ?", UUID.class, admin.getId()))
                .containsExactlyInAnyOrder(postA, postB);
        assertThat(jdbcTemplate
                        .queryForObject(
                                "SELECT created_at FROM post_bookmarks WHERE user_id = ? AND post_id = ?",
                                OffsetDateTime.class,
                                admin.getId(),
                                postB)
                        .toInstant())
                .isEqualTo(savedAt.toInstant());
        assertThat(count("SELECT count(*) FROM post_bookmarks WHERE user_id = ?", reader.getId()))
                .isZero();
        Map<String, Object> merged = jdbcTemplate.queryForMap(
                "SELECT role, email, display_name, github_id, github_login, avatar_url FROM users WHERE id = ?",
                admin.getId());
        assertThat(merged.get("role")).isEqualTo("ADMIN");
        assertThat(merged.get("email")).isEqualTo(email);
        assertThat(merged.get("display_name")).isEqualTo("Admin " + email);
        assertThat(merged.get("github_id")).isEqualTo(githubId);
        assertThat(merged.get("github_login")).isEqualTo("chu-site-" + suffix);
        assertThat(merged.get("avatar_url")).isEqualTo(reader.getAvatarUrl());
        assertThat(messages(Level.WARN))
                .singleElement()
                .asString()
                .contains("merged GitHub reader account into admin")
                .contains("githubId=" + githubId)
                .contains("oldUserId=" + reader.getId())
                .contains("comments=2")
                .contains("likes=1")
                .contains("bookmarks=1");

        // The next GitHub login with that id lands on the admin row: an ADMIN token, with sub being the admin.
        // GitHub goes through the same second step as the password: 202 and a challenge, then the code opens the
        // session.
        AuthTestSupport.EnrolledAccount enrolled = auth.enroll(admin);
        MockHttpServletResponse login = new GithubLoginFlow(mockMvc, GITHUB)
                .login(GithubStub.profile(githubId, "chu-site-" + suffix, "Site Owner"))
                .getResponse();
        assertThat(login.getStatus()).as(login.getContentAsString()).isEqualTo(202);
        Jwt jwt = jwtDecoder.decode(
                auth.completeSecondStep(mockMvc, login, enrolled).accessToken());
        assertThat(jwt.getSubject()).isEqualTo(admin.getId().toString());
        assertThat(jwt.getClaimAsString("role")).isEqualTo("ADMIN");
    }

    @Test
    void a_merge_ends_the_sessions_the_admin_had_before_it() throws Exception {
        String email = adminEmail("gop-phien");
        User admin = auth.createAccount(email, UserRole.ADMIN);
        long githubId = auth.nextGithubId();
        auth.createReader(githubId, "gop-phien-" + suffix);
        String refreshBefore = auth.verifiedRefreshToken(admin);
        String accessBefore = auth.bearerIssuedAt(admin, Instant.now().minusSeconds(30));

        run(email, githubId);

        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", accessBefore))
                .andExpect(status().isUnauthorized());
        assertThat(revoked(refreshBefore)).isTrue();
        assertThat(tokensValidAfter(admin.getId())).isNotNull();
    }

    @Test
    void
            merge_moves_likes_comments_and_notifications_to_admin_dropping_only_rows_that_would_self_notify_and_duplicates() {
        String email = adminEmail("gop-thong-bao");
        UUID admin = auth.createAccount(email, UserRole.ADMIN).getId();
        long githubId = auth.nextGithubId();
        UUID reader = auth.createReader(githubId, "chu-site-tb-" + suffix).getId();
        UUID other =
                auth.createReader(auth.nextGithubId(), "doc-gia-khac-" + suffix).getId();
        UUID post = insertDraftPost("gop-thong-bao", admin);
        UUID otherFirst = insertComment(post, other, null, "first comment from someone else");
        UUID otherSecond = insertComment(post, other, null, "second comment from someone else");
        UUID readerComment = insertComment(post, reader, null, "comment from the reader about to be merged");
        UUID adminComment = insertComment(post, admin, null, "comment from the admin");
        UUID readerReply = insertComment(post, reader, otherFirst, "reader replies to someone else");
        UUID otherReply = insertComment(post, other, readerComment, "someone else replies to the reader");
        // Comment likes: one duplicates a like the admin already has, one becomes the admin liking their own comment
        // (allowed).
        likeComment(otherFirst, reader);
        likeComment(otherFirst, admin);
        likeComment(otherSecond, reader);
        likeComment(adminComment, reader);

        // The reader is the actor: moved to the admin, except the duplicate of a like notification the admin already
        // has.
        UUID replied = notification(other, reader, "COMMENT_REPLIED", post, readerReply);
        UUID duplicateLike = notification(other, reader, "COMMENT_LIKED", post, otherFirst);
        UUID adminLike = notification(other, admin, "COMMENT_LIKED", post, otherFirst);
        UUID movedLike = notification(other, reader, "COMMENT_LIKED", post, otherSecond);
        // Between the reader and the admin: it would become a self-notification, dropped.
        UUID selfCommented = notification(admin, reader, "POST_COMMENTED", post, readerComment);
        UUID selfLiked = notification(admin, reader, "POST_LIKED", post, null);
        UUID selfCommentLiked = notification(reader, admin, "COMMENT_LIKED", post, readerComment);
        // The reader is the recipient: the inbox becomes the admin's, except the duplicate.
        UUID receivedReply = notification(reader, other, "COMMENT_REPLIED", post, otherReply);
        UUID receivedDuplicate = notification(reader, other, "COMMENT_LIKED", post, readerComment);
        UUID adminReceived = notification(admin, other, "COMMENT_LIKED", post, readerComment);
        UUID untouched = notification(admin, other, "POST_LIKED", post, null);

        assertThatCode(() -> run(email, githubId)).doesNotThrowAnyException();

        assertThat(jdbcTemplate.queryForList(
                        "SELECT comment_id FROM comment_likes WHERE user_id = ?", UUID.class, admin))
                .containsExactlyInAnyOrder(otherFirst, otherSecond, adminComment);
        assertThat(count("SELECT count(*) FROM comment_likes WHERE user_id = ?", reader))
                .isZero();
        assertThat(count("SELECT count(*) FROM notifications WHERE recipient_id = ? OR actor_id = ?", reader, reader))
                .isZero();
        assertThat(people(replied)).containsExactly(other, admin);
        assertThat(people(movedLike)).containsExactly(other, admin);
        assertThat(people(receivedReply)).containsExactly(admin, other);
        for (UUID dropped : List.of(duplicateLike, selfCommented, selfLiked, selfCommentLiked, receivedDuplicate)) {
            assertThat(count("SELECT count(*) FROM notifications WHERE id = ?", dropped))
                    .as(dropped.toString())
                    .isZero();
        }
        assertThat(people(adminLike)).containsExactly(other, admin);
        assertThat(people(adminReceived)).containsExactly(admin, other);
        assertThat(people(untouched)).containsExactly(admin, other);
        assertThat(messages(Level.WARN))
                .singleElement()
                .asString()
                .contains("commentLikes=2")
                .contains("notifications=3");
    }

    @Test
    void github_linked_to_admin_receives_like_and_comment_notifications_on_admins_posts() throws Exception {
        String email = adminEmail("nhan-thong-bao");
        User admin = auth.createAccount(email, UserRole.ADMIN);
        long githubId = auth.nextGithubId();
        run(email, githubId);
        CommentFixtures f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
        Post post = f.publishedPostBy(auth.bearerFor(admin), "Admin post with a linked GitHub account");
        Reader reader = f.reader("doc-gia-cua-chu-site");
        f.likePost(reader, post, true).andExpect(status().isOk());
        f.createdId(f.create(reader, post, "Comment sent to the site owner"));

        // The site owner reads the blog through GitHub: that session is the admin row, the author of the post, so it
        // sees the notification.
        AuthTestSupport.EnrolledAccount enrolled = auth.enroll(admin);
        MockHttpServletResponse login = new GithubLoginFlow(mockMvc, GITHUB)
                .login(GithubStub.profile(githubId, "chu-site-tb-" + suffix, "Site Owner"))
                .getResponse();
        String bearer =
                "Bearer " + auth.completeSecondStep(mockMvc, login, enrolled).accessToken();
        Reader owner = new Reader(admin.getId(), bearer, "chu-site-tb-" + suffix, admin.getDisplayName());

        JsonNode inbox = f.inbox(owner);
        assertThat(inbox.path("items"))
                .extracting(
                        item -> item.path("type").asString(),
                        item -> item.path("post").path("slug").asString(),
                        item -> item.path("actor").path("githubLogin").asString())
                .containsExactly(
                        tuple("POST_COMMENTED", post.slug(), reader.login()),
                        tuple("POST_LIKED", post.slug(), reader.login()));
        assertThat(f.unreadCount(owner)).isEqualTo(2);
    }

    @Test
    void suspended_reader_is_also_merged_and_log_records_the_old_status() {
        String email = adminEmail("gop-khoa");
        UUID admin = auth.createAccount(email, UserRole.ADMIN).getId();
        long githubId = auth.nextGithubId();
        User reader = auth.createReader(githubId, "khoa-" + suffix, UserStatus.SUSPENDED);

        run(email, githubId);

        assertThat(githubIdOf(admin)).isEqualTo(githubId);
        assertThat(jdbcTemplate.queryForObject("SELECT status FROM users WHERE id = ?", String.class, admin))
                .isEqualTo("ACTIVE");
        assertThat(count("SELECT count(*) FROM users WHERE id = ?", reader.getId()))
                .isZero();
        assertThat(messages(Level.WARN)).singleElement().asString().contains("oldStatus=SUSPENDED");
    }

    @Test
    void id_of_another_ADMIN_or_AUTHOR_is_not_linked_and_changes_nothing() {
        for (UserRole otherRole : List.of(UserRole.ADMIN, UserRole.AUTHOR)) {
            logs.list.clear();
            String email = adminEmail("dac-quyen-" + otherRole.name().toLowerCase());
            UUID admin = auth.createAccount(email, UserRole.ADMIN).getId();
            UUID other = auth.createAccount(
                            adminEmail("khac-" + otherRole.name().toLowerCase()), otherRole)
                    .getId();
            long githubId = auth.nextGithubId();
            jdbcTemplate.update("UPDATE users SET github_id = ? WHERE id = ?", githubId, other);

            assertThatCode(() -> run(email, githubId)).doesNotThrowAnyException();

            assertThat(githubIdOf(admin)).as(otherRole.name()).isNull();
            assertThat(githubIdOf(other)).as(otherRole.name()).isEqualTo(githubId);
            assertThat(messages(Level.WARN))
                    .as(otherRole.name())
                    .singleElement()
                    .asString()
                    .contains("belongs to another privileged account");
        }
    }

    @Test
    void admin_already_linked_to_another_id_stays_as_is() {
        String email = adminEmail("da-lien-ket");
        UUID admin = auth.createAccount(email, UserRole.ADMIN).getId();
        long linked = auth.nextGithubId();
        jdbcTemplate.update("UPDATE users SET github_id = ? WHERE id = ?", linked, admin);
        long other = auth.nextGithubId();
        UUID readerOfOther = auth.createReader(other, "nguoi-khac-" + suffix).getId();

        assertThatCode(() -> run(email, other)).doesNotThrowAnyException();

        assertThat(githubIdOf(admin)).isEqualTo(linked);
        // The reader holding the other id is not merged into anything.
        assertThat(githubIdOf(readerOfOther)).isEqualTo(other);
        assertThat(messages(Level.WARN)).singleElement().asString().contains("already linked to a different GitHub id");
    }

    @Test
    void no_admin_row_with_that_email_only_warns_even_if_it_is_a_demoted_ADMIN() {
        long githubId = auth.nextGithubId();
        // An account with that email exists but is no longer ADMIN (demoted): also "no admin row", and it is not
        // promoted again or linked.
        String authorEmail = adminEmail("ha-xuong-author");
        String readerEmail = adminEmail("ha-xuong-user");
        UUID author = auth.createAccount(authorEmail, UserRole.ADMIN).getId();
        UUID reader = auth.createAccount(readerEmail, UserRole.ADMIN).getId();
        auth.setRole(author, UserRole.AUTHOR);
        auth.setRole(reader, UserRole.USER);

        assertThatCode(() -> run(adminEmail("khong-co"), githubId)).doesNotThrowAnyException();
        assertThatCode(() -> run(authorEmail, githubId)).doesNotThrowAnyException();
        assertThatCode(() -> run(readerEmail, githubId)).doesNotThrowAnyException();

        assertThat(githubIdOf(author)).isNull();
        assertThat(githubIdOf(reader)).isNull();
        assertThat(roleOf(author)).isEqualTo("AUTHOR");
        assertThat(roleOf(reader)).isEqualTo("USER");
        assertThat(messages(Level.WARN))
                .hasSize(3)
                .allSatisfy(message -> assertThat(message).contains("not found"));
    }

    @Test
    void db_error_during_merge_rolls_everything_back_and_startup_continues() {
        String email = adminEmail("loi-db");
        UUID admin = auth.createAccount(email, UserRole.ADMIN).getId();
        long githubId = auth.nextGithubId();
        UUID reader = auth.createReader(githubId, "loi-db-" + suffix).getId();
        UUID post = insertDraftPost("loi-db");
        UUID comment = insertComment(post, reader, null, "comment must stay with the reader");
        // A post under the reader's own name (only hand-written SQL can do this): posts.author_id is NO ACTION, so the
        // statement deleting the reader
        // row at step 5 is refused, after the comments were already moved at step 1.
        UUID authored = insertDraftPost("loi-db-tac-gia", reader);
        try {
            assertThatCode(() -> run(email, githubId)).doesNotThrowAnyException();

            assertThat(messages(Level.WARN))
                    .singleElement()
                    .asString()
                    .startsWith("admin GitHub link skipped: org.springframework.dao.");
            // Fully rolled back: the comments still belong to the reader, the reader still holds the id, the admin is
            // not linked.
            assertThat(jdbcTemplate.queryForObject("SELECT user_id FROM comments WHERE id = ?", UUID.class, comment))
                    .isEqualTo(reader);
            assertThat(githubIdOf(reader)).isEqualTo(githubId);
            assertThat(githubIdOf(admin)).isNull();
        } finally {
            jdbcTemplate.update("DELETE FROM posts WHERE id = ?", authored);
        }
    }

    // --- Helpers -----------------------------------------------------------------------------------------

    /** The real runner, on the admin account with this email, linking with this id. */
    private void run(String email, long githubId) {
        AdminAccountProperties properties = new Binder(new MapConfigurationPropertySource(
                        Map.of("app.admin.email", email, "app.admin.github-id", Long.toString(githubId))))
                .bind("app.admin", AdminAccountProperties.class)
                .get();
        new AdminGithubLink(properties, jdbcTemplate, refreshTokenService, transactionManager)
                .run(new DefaultApplicationArguments());
    }

    private String adminEmail(String stem) {
        return "github-link-" + stem + "-" + suffix + "@blog.local";
    }

    private List<String> messages(Level level) {
        return logs.list.stream()
                .filter(event -> event.getLevel() == level)
                .map(ILoggingEvent::getFormattedMessage)
                .toList();
    }

    private boolean revoked(String rawRefreshToken) {
        return jdbcTemplate.queryForObject(
                "SELECT revoked_at IS NOT NULL FROM refresh_tokens WHERE token_hash = ?",
                Boolean.class,
                RefreshTokenService.hash(rawRefreshToken));
    }

    private Instant tokensValidAfter(UUID userId) {
        Timestamp cutOff = jdbcTemplate.queryForObject(
                "SELECT tokens_valid_after FROM users WHERE id = ?", Timestamp.class, userId);
        return cutOff == null ? null : cutOff.toInstant();
    }

    private Long githubIdOf(UUID userId) {
        return jdbcTemplate.queryForObject("SELECT github_id FROM users WHERE id = ?", Long.class, userId);
    }

    private String roleOf(UUID userId) {
        return jdbcTemplate.queryForObject("SELECT role FROM users WHERE id = ?", String.class, userId);
    }

    private long count(String sql, Object... args) {
        return jdbcTemplate.queryForObject(sql, Long.class, args);
    }

    private UUID insertDraftPost(String slugStem) {
        return insertDraftPost(slugStem, SEEDED_ADMIN);
    }

    /** A draft: no public page lists it. */
    private UUID insertDraftPost(String slugStem, UUID authorId) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO posts (id, title, slug, content, status, author_id) " + "VALUES (?, ?, ?, ?, 'DRAFT', ?)",
                id,
                "GitHub link " + slugStem + " " + suffix,
                "lien-ket-github-" + slugStem + "-" + suffix,
                "Content " + suffix,
                authorId);
        return id;
    }

    private UUID insertComment(UUID post, UUID user, UUID parent, String content) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO comments (id, post_id, user_id, parent_id, content) VALUES (?, ?, ?, ?, ?)",
                id,
                post,
                user,
                parent,
                content);
        return id;
    }

    private void like(UUID post, UUID user) {
        jdbcTemplate.update("INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)", post, user);
    }

    private void bookmark(UUID post, UUID user, OffsetDateTime savedAt) {
        jdbcTemplate.update(
                "INSERT INTO post_bookmarks (user_id, post_id, created_at) VALUES (?, ?, ?)", user, post, savedAt);
    }

    private void likeComment(UUID comment, UUID user) {
        jdbcTemplate.update("INSERT INTO comment_likes (comment_id, user_id) VALUES (?, ?)", comment, user);
    }

    /** A notification written directly with SQL; the merge does not look at whether the post is published. */
    private UUID notification(UUID recipient, UUID actor, String type, UUID post, UUID comment) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO notifications (id, recipient_id, actor_id, type, post_id, comment_id) "
                        + "VALUES (?, ?, ?, ?, ?, ?)",
                id,
                recipient,
                actor,
                type,
                post,
                comment);
        return id;
    }

    /** The recipient, then the actor, of a notification. */
    private List<UUID> people(UUID notification) {
        return jdbcTemplate.queryForObject(
                "SELECT recipient_id, actor_id FROM notifications WHERE id = ?",
                (rs, row) -> List.of(rs.getObject("recipient_id", UUID.class), rs.getObject("actor_id", UUID.class)),
                notification);
    }
}
