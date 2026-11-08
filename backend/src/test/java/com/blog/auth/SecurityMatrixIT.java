package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.comment.CommentFixtures;
import com.blog.comment.CommentFixtures.Post;
import com.blog.newsletter.service.NewsletterTokens;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.GithubLoginFlow;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.AbstractMockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The authorization table of the design, row by row, for each column: anonymous, USER, AUTHOR, ADMIN. Each cell is one real call
 * through the real filter chain, with a real token of a real account, and checks the exact HTTP status (the same error code when it is an error), not
 * merely "not 401/403". The "open" cells of the token-issuing chain and the GitHub login chain are checked by the answer of the
 * controller or handler (200, 204, 302, OAUTH_STATE_INVALID), not of the filter.
 *
 * Outside the table are the points the table only notes: a suspended USER (403 USER_SUSPENDED), only an ADMIN can change roles (by hand
 * or by approving an author application; PATCH /auth/me is 405), the writer is always the token owner and never an id in the body
 * or query, a token self-signed with another key gets 401 on every path of the main chain (the token-issuing chain and the GitHub login chain
 * do not read the Bearer header: there it is ignored, not rejected), and {@code mine}/{@code liked} follow the token.
 *
 * One cell does not measure a real 200: ADMIN with {@code PUT /api/v1/admin/posts/featured-order}. The "Featured posts" order belongs to the whole
 * site, and the DB is shared by every test class, so that cell sends a list with a duplicate id: the service returns 400, meaning it passed the role check
 * without writing anything. FeaturedOrderIT measures the 200 path.
 *
 * Every account is created separately for this class, ADMIN included: the comment and like rate limits are counted per person, in the memory
 * of the shared context, so the seed admin's share must not be spent. Each calling person creates two comments, edits and deletes four times,
 * likes and unlikes four times (posts and comments), and submits one author application across the whole table; the comments, notifications
 * and applications that must exist beforehand are written directly with SQL. This class replaces the earlier ReaderUrlRulesIT (written before there was any
 * controller): each of its cases is a row here, with the exact answer.
 */
@AutoConfigureMockMvc
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class SecurityMatrixIT extends AbstractIntegrationTest {

    private static final String ME = "/api/v1/auth/me";
    private static final String COMMENTS = "/api/v1/comments/";
    private static final String NOTIFICATIONS = "/api/v1/notifications";
    private static final String ADMIN_POSTS = "/api/v1/admin/posts";
    private static final String ADMIN_COMMENTS = "/api/v1/admin/comments/";
    private static final String ADMIN_USERS = "/api/v1/admin/users/";
    private static final String MY_APPLICATION = "/api/v1/me/author-application";
    private static final String ADMIN_APPLICATIONS = "/api/v1/admin/author-applications";
    private static final String BOOKMARKS = "/api/v1/me/bookmarks";
    private static final String LOGIN_PASSWORD = "mat-khau-cua-ma-tran-phan-quyen";

    /** The four columns of the table. */
    enum Caller {
        ANONYMOUS,
        USER,
        AUTHOR,
        ADMIN
    }

    /** The expected answer: the HTTP status, with the error code when it is an error. */
    record Expect(int status, String code) {

        @Override
        public String toString() {
            return code == null ? String.valueOf(status) : status + " " + code;
        }
    }

    /**
     * One call of a row, built from the data of that call. A common type for every request builder: since Spring 7, the
     * multipart builder (image upload) is no longer a MockHttpServletRequestBuilder.
     */
    @FunctionalInterface
    interface Call {
        AbstractMockHttpServletRequestBuilder<?> build(Scene scene) throws Exception;
    }

    /** One row of the table: one call, and the expected answer in each column. */
    record Row(String name, Call call, Map<Caller, Expect> expected) {}

    private record Account(UUID id, String bearer) {}

    private static final Expect UNAUTHENTICATED = error(401, "UNAUTHENTICATED");
    private static final Expect FORBIDDEN = error(403, "FORBIDDEN");
    private static final Expect REAUTHENTICATION_REQUIRED = error(401, "REAUTHENTICATION_REQUIRED");

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private NewsletterTokens newsletterTokens;

    private CommentFixtures fixtures;
    private Account user;
    private Account author;
    private Account admin;
    /** Another reader: the owner of "another person's comment". */
    private Account other;
    /** An account with a real password, for the login, refresh and logout rows. */
    private User loginUser;
    /** The public handle of the USER: its profile is the GET /api/v1/users/{slug} row. */
    private String userSlug;

    private Post published;
    /** The old slug of a post that was published and then had its slug changed: its lookup path returns 200. */
    private String movedSlug;

    private UUID authorDraft;
    private UUID adminDraft;
    /** {@code <uuid>.png}: the cover image of the AUTHOR's draft, for the /api/v1/media row. */
    private String coverFile;
    /** The bytes of the opaque.png fixture: the cover image above and the uploads of images inside the post body. */
    private byte[] png;

    @BeforeAll
    void createAccountsAndPosts() throws Exception {
        try (InputStream in = SecurityMatrixIT.class.getResourceAsStream("/media/opaque.png")) {
            assertThat(in).as("fixture opaque.png").isNotNull();
            png = in.readAllBytes();
        }
        fixtures = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
        String suffix = fixtures.suffix;
        User reader = auth.createReader(auth.nextGithubId(), "ma-tran-user-" + suffix);
        user = account(reader);
        userSlug = reader.getPublicSlug();
        author = account(auth.createAuthor("ma-tran-author-" + suffix + "@blog.local"));
        admin = account(auth.createAccount("ma-tran-admin-" + suffix + "@blog.local", UserRole.ADMIN));
        other = account(auth.createReader(auth.nextGithubId(), "ma-tran-khac-" + suffix));

        loginUser = auth.createAccount("ma-tran-login-" + suffix + "@blog.local", UserRole.AUTHOR);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                passwordEncoder.encode(LOGIN_PASSWORD),
                loginUser.getId());

        published = fixtures.publishedPost("Post of the permission matrix");
        Post moved = fixtures.publishedPost("Slug-change post of the matrix");
        renameSlug(moved, moved.slug() + "-moi");
        movedSlug = moved.slug();
        adminDraft = fixtures.draftPost("Admin draft for the matrix").id();
        authorDraft = createDraft(author, "Author draft for the matrix " + suffix);
        coverFile = uploadCover(author, authorDraft);
    }

    // --- The authorization table -----------------------------------------------------------------------

    static Stream<Arguments> matrix() {
        return rows().stream()
                .flatMap(row -> Arrays.stream(Caller.values())
                        .map(caller ->
                                Arguments.of(row.name(), caller, row.expected().get(caller), row.call())));
    }

    private static List<Row> rows() {
        return List.of(
                // Issuing and revoking tokens: chain @Order(1), no resource server, open to every caller.
                open("POST /api/v1/auth/login", s -> withJson(post("/api/v1/auth/login"), s.loginBody()), ok(200)),
                open(
                        "POST /api/v1/auth/refresh",
                        s -> withJson(post("/api/v1/auth/refresh"), s.refreshBody()),
                        ok(200)),
                open("POST /api/v1/auth/logout", s -> withJson(post("/api/v1/auth/logout"), s.refreshBody()), ok(204)),
                // The second step of a sign-in: the challenge is the only credential, so a token attached to the
                // request
                // changes nothing; an unknown challenge is the same refusal for everyone.
                open(
                        "POST /api/v1/auth/mfa/verify",
                        s -> withJson(
                                post("/api/v1/auth/mfa/verify"),
                                "{\"challenge\":\"ma-tran-khong-ton-tai\",\"code\":\"123456\"}"),
                        error(401, "MFA_CHALLENGE_INVALID")),
                // GitHub login: chain @Order(2), also does not read an attached token.
                open("GET /api/v1/auth/oauth2/authorization/github", s -> get(GithubLoginFlow.START_PATH), ok(302)),
                open(
                        "GET /api/v1/auth/oauth2/callback/github, no cookie",
                        s -> get(GithubLoginFlow.CALLBACK_PATH)
                                .queryParam("code", "ma-tran")
                                .queryParam("state", "ma-tran")
                                .accept(APPLICATION_JSON),
                        error(401, "OAUTH_STATE_INVALID")),
                // /auth/me: any valid token. There is no write path: another method passes the URL rule, then gets 405.
                signedIn("GET /api/v1/auth/me", s -> get(ME), ok(200)),
                signedIn(
                        "PATCH /api/v1/auth/me {role: ADMIN}",
                        s -> withJson(patch(ME), "{\"role\":\"ADMIN\"}"),
                        error(405, "VALIDATION_ERROR")),
                // The signed-in person's own security. The status is for any signed-in account. Managing two-step
                // verification is for ADMIN and AUTHOR (a USER is stopped by the URL rule); the tokens of this matrix
                // belong to sessions that started a day ago, so the recent sign-in the service asks for first is
                // missing: 401 REAUTHENTICATION_REQUIRED is the proof that no mutation runs before that check.
                // MfaReauthIT and MfaReplaceIT cover the rest.
                signedIn("GET /api/v1/me/mfa", s -> get("/api/v1/me/mfa"), ok(200)),
                managesMfa(
                        "POST /api/v1/me/mfa/enroll/begin", s -> withJson(post("/api/v1/me/mfa/enroll/begin"), "{}")),
                managesMfa(
                        "POST /api/v1/me/mfa/enroll/confirm",
                        s -> withJson(post("/api/v1/me/mfa/enroll/confirm"), "{\"code\":\"123456\"}")),
                managesMfa(
                        "POST /api/v1/me/mfa/recovery-codes/regenerate",
                        s -> withJson(post("/api/v1/me/mfa/recovery-codes/regenerate"), "{\"code\":\"123456\"}")),
                managesMfa(
                        "POST /api/v1/me/mfa/replace/begin",
                        s -> withJson(post("/api/v1/me/mfa/replace/begin"), "{\"code\":\"123456\"}")),
                managesMfa(
                        "POST /api/v1/me/mfa/replace/confirm",
                        s -> withJson(post("/api/v1/me/mfa/replace/confirm"), "{\"code\":\"123456\"}")),
                managesMfa("DELETE /api/v1/me/mfa", s -> withJson(delete("/api/v1/me/mfa"), "{\"code\":\"123456\"}")),
                signedIn(
                        "POST /api/v1/me/password",
                        s -> withJson(
                                post("/api/v1/me/password"),
                                "{\"currentPassword\":\"mat-khau-hien-tai\",\"newPassword\":\"mat-khau-moi-rat-dai-77\"}"),
                        REAUTHENTICATION_REQUIRED),
                // Public reads.
                open("GET /api/v1/posts", s -> get("/api/v1/posts"), ok(200)),
                open("GET /api/v1/posts/{slug}", s -> get(s.post()), ok(200)),
                open(
                        "GET /api/v1/posts/search",
                        s -> get("/api/v1/posts/search").param("q", "matrix"),
                        ok(200)),
                // Search over every kind of content, GET only.
                open("GET /api/v1/search", s -> get("/api/v1/search").param("q", "matrix"), ok(200)),
                open("GET /api/v1/categories", s -> get("/api/v1/categories"), ok(200)),
                // The language filter is a public read too; a language that is not enabled is a 400 for everyone.
                open("GET /api/v1/posts?lang=en", s -> get("/api/v1/posts").param("lang", "en"), ok(200)),
                open("GET /api/v1/posts?lang=fr", s -> get("/api/v1/posts").param("lang", "fr"), ok(400)),
                open(
                        "GET /api/v1/categories?lang=en",
                        s -> get("/api/v1/categories").param("lang", "en"),
                        ok(200)),
                open(
                        "GET /api/v1/search?lang=en",
                        s -> get("/api/v1/search").param("q", "matrix").param("lang", "en"),
                        ok(200)),
                open("GET /api/v1/tags", s -> get("/api/v1/tags"), ok(200)),
                open("GET /api/v1/series", s -> get("/api/v1/series"), ok(200)),
                open("GET /api/v1/gallery", s -> get("/api/v1/gallery"), ok(200)),
                open("GET /api/v1/media/{id}.{ext}", s -> get("/api/v1/media/" + s.coverFile()), ok(200)),
                open("GET /api/v1/stats", s -> get("/api/v1/stats"), ok(200)),
                open("GET /api/v1/posts/{slug}/comments", s -> get(s.post() + "/comments"), ok(200)),
                open("GET /api/v1/posts/{slug}/like", s -> get(s.post() + "/like"), ok(200)),
                // The old slug of a post whose slug changed, a public read like the post itself.
                open("GET /api/v1/posts/{slug}/redirect", s -> get(s.movedPost() + "/redirect"), ok(200)),
                open("POST /api/v1/posts/{slug}/views", s -> post(s.post() + "/views"), ok(204)),
                // Public profile, GET only with exactly one slug segment; the person's posts go through /posts?author=.
                open("GET /api/v1/users/{slug}", s -> get(s.profile()), ok(200)),
                open("GET /api/v1/posts?author=", s -> get("/api/v1/posts").param("author", s.profileSlug()), ok(200)),
                // Reader writes: login required, every role. Edit and delete only one's own comments, ADMIN included:
                // moderation
                // goes through the /api/v1/admin/comments path.
                signedIn(
                        "POST /api/v1/posts/{slug}/comments",
                        s -> withJson(post(s.post() + "/comments"), s.newContent()),
                        ok(201)),
                signedIn(
                        "POST /api/v1/comments/{id}/replies",
                        s -> withJson(post(COMMENTS + s.othersComment() + "/replies"), s.newContent()),
                        ok(201)),
                signedIn(
                        "PUT /api/v1/comments/{id}, own",
                        s -> withJson(put(COMMENTS + s.ownComment()), s.newContent()),
                        ok(200)),
                signedIn(
                        "PUT /api/v1/comments/{id}, someone else's",
                        s -> withJson(put(COMMENTS + s.othersComment()), s.newContent()),
                        FORBIDDEN),
                signedIn("DELETE /api/v1/comments/{id}, own", s -> delete(COMMENTS + s.ownComment()), ok(204)),
                signedIn(
                        "DELETE /api/v1/comments/{id}, someone else's",
                        s -> delete(COMMENTS + s.othersComment()),
                        FORBIDDEN),
                signedIn("PUT /api/v1/posts/{slug}/like", s -> put(s.post() + "/like"), ok(200)),
                signedIn("DELETE /api/v1/posts/{slug}/like", s -> delete(s.post() + "/like"), ok(200)),
                // Comment likes and the notification inbox, login required, every role. The inbox is only one's own,
                // even
                // for ADMIN: another person's notification is 404, never 403.
                signedIn("PUT /api/v1/comments/{id}/like", s -> put(COMMENTS + s.othersComment() + "/like"), ok(200)),
                signedIn(
                        "DELETE /api/v1/comments/{id}/like",
                        s -> delete(COMMENTS + s.othersComment() + "/like"),
                        ok(200)),
                signedIn("GET /api/v1/notifications", s -> get(NOTIFICATIONS), ok(200)),
                signedIn("GET /api/v1/notifications/unread-count", s -> get(NOTIFICATIONS + "/unread-count"), ok(200)),
                signedIn(
                        "POST /api/v1/notifications/{id}/read, own",
                        s -> post(NOTIFICATIONS + "/" + s.ownNotification() + "/read"),
                        ok(200)),
                signedIn(
                        "POST /api/v1/notifications/{id}/read, someone else's",
                        s -> post(NOTIFICATIONS + "/" + s.othersNotification() + "/read"),
                        error(404, "NOTIFICATION_NOT_FOUND")),
                signedIn("POST /api/v1/notifications/read-all", s -> post(NOTIFICATIONS + "/read-all"), ok(200)),
                signedIn(
                        "DELETE /api/v1/notifications/{id}, own",
                        s -> delete(NOTIFICATIONS + "/" + s.ownNotification()),
                        ok(200)),
                signedIn(
                        "DELETE /api/v1/notifications/{id}, someone else's",
                        s -> delete(NOTIFICATIONS + "/" + s.othersNotification()),
                        error(404, "NOTIFICATION_NOT_FOUND")),
                // The CMS: a USER is blocked by the URL rule (403), an AUTHOR follows the ownership rule (own posts),
                // ADMIN any post.
                cms("GET /api/v1/admin/posts", s -> get(ADMIN_POSTS), ok(200), ok(200)),
                cms("POST /api/v1/admin/posts", s -> withJson(post(ADMIN_POSTS), s.newDraft()), ok(201), ok(201)),
                cms(
                        "GET /api/v1/admin/posts/{id}, post of the AUTHOR",
                        s -> get(ADMIN_POSTS + "/" + s.authorDraft()),
                        ok(200),
                        ok(200)),
                cms(
                        "GET /api/v1/admin/posts/{id}, someone else's post",
                        s -> get(ADMIN_POSTS + "/" + s.adminDraft()),
                        FORBIDDEN,
                        ok(200)),
                // "Featured posts" is a site decision, ADMIN only, even for the AUTHOR's own post.
                cms(
                        "POST /api/v1/admin/posts/{id}/feature, post of the AUTHOR",
                        s -> post(ADMIN_POSTS + "/" + s.authorDraft() + "/feature"),
                        FORBIDDEN,
                        ok(200)),
                cms(
                        "POST /api/v1/admin/posts/{id}/unfeature, post of the AUTHOR",
                        s -> post(ADMIN_POSTS + "/" + s.authorDraft() + "/unfeature"),
                        FORBIDDEN,
                        ok(200)),
                cms(
                        "PUT /api/v1/admin/posts/featured-order, duplicate id",
                        s -> withJson(put(ADMIN_POSTS + "/featured-order"), s.duplicateOrder()),
                        FORBIDDEN,
                        error(400, "VALIDATION_ERROR")),
                cms("GET /api/v1/admin/categories", s -> get("/api/v1/admin/categories"), ok(200), ok(200)),
                cms("GET /api/v1/admin/tags", s -> get("/api/v1/admin/tags"), ok(200), ok(200)),
                // View statistics, an AUTHOR sees only their own posts (the scope is checked in AnalyticsIT).
                cms("GET /api/v1/admin/analytics", s -> get("/api/v1/admin/analytics"), ok(200), ok(200)),
                // Images in the post body and revisions, the same rule as the post (owner or ADMIN). Each cell has its
                // own image
                // and revision, written directly with SQL.
                cms(
                        "POST /api/v1/admin/posts/{id}/images, post of the AUTHOR",
                        s -> s.imageUpload(s.authorDraft()),
                        ok(200),
                        ok(200)),
                cms(
                        "POST /api/v1/admin/posts/{id}/images, someone else's post",
                        s -> s.imageUpload(s.adminDraft()),
                        FORBIDDEN,
                        ok(200)),
                cms(
                        "GET /api/v1/admin/posts/{id}/images, post of the AUTHOR",
                        s -> get(ADMIN_POSTS + "/" + s.authorDraft() + "/images"),
                        ok(200),
                        ok(200)),
                cms(
                        "GET /api/v1/admin/posts/{id}/images, someone else's post",
                        s -> get(ADMIN_POSTS + "/" + s.adminDraft() + "/images"),
                        FORBIDDEN,
                        ok(200)),
                cms(
                        "DELETE /api/v1/admin/posts/{id}/images/{mediaId}, post of the AUTHOR",
                        s -> delete(ADMIN_POSTS + "/" + s.authorDraft() + "/images/" + s.bodyImage(s.authorDraft())),
                        ok(200),
                        ok(200)),
                cms(
                        "DELETE /api/v1/admin/posts/{id}/images/{mediaId}, someone else's post",
                        s -> delete(ADMIN_POSTS + "/" + s.adminDraft() + "/images/" + s.bodyImage(s.adminDraft())),
                        FORBIDDEN,
                        ok(200)),
                cms(
                        "GET /api/v1/admin/posts/{id}/revisions, post of the AUTHOR",
                        s -> get(ADMIN_POSTS + "/" + s.authorDraft() + "/revisions"),
                        ok(200),
                        ok(200)),
                cms(
                        "GET /api/v1/admin/posts/{id}/revisions, someone else's post",
                        s -> get(ADMIN_POSTS + "/" + s.adminDraft() + "/revisions"),
                        FORBIDDEN,
                        ok(200)),
                cms(
                        "GET /api/v1/admin/posts/{id}/revisions/{revisionId}, post of the AUTHOR",
                        s -> get(ADMIN_POSTS + "/" + s.authorDraft() + "/revisions/" + s.revision(s.authorDraft())),
                        ok(200),
                        ok(200)),
                cms(
                        "GET /api/v1/admin/posts/{id}/revisions/{revisionId}, someone else's post",
                        s -> get(ADMIN_POSTS + "/" + s.adminDraft() + "/revisions/" + s.revision(s.adminDraft())),
                        FORBIDDEN,
                        ok(200)),
                cms(
                        "POST /api/v1/admin/posts/{id}/revisions/{revisionId}/restore, post of the AUTHOR",
                        s -> post(ADMIN_POSTS + "/" + s.authorDraft() + "/revisions/" + s.revision(s.authorDraft())
                                + "/restore"),
                        ok(200),
                        ok(200)),
                cms(
                        "POST /api/v1/admin/posts/{id}/revisions/{revisionId}/restore, someone else's post",
                        s -> post(ADMIN_POSTS + "/" + s.adminDraft() + "/revisions/" + s.revision(s.adminDraft())
                                + "/restore"),
                        FORBIDDEN,
                        ok(200)),
                // Translations of a post: the rule of every post route, and a link needs BOTH posts to be the caller's.
                cms(
                        "GET /api/v1/admin/posts/{id}/translations, post of the AUTHOR",
                        s -> get(ADMIN_POSTS + "/" + s.authorDraft() + "/translations"),
                        ok(200),
                        ok(200)),
                cms(
                        "GET /api/v1/admin/posts/{id}/translations, someone else's post",
                        s -> get(ADMIN_POSTS + "/" + s.adminDraft() + "/translations"),
                        FORBIDDEN,
                        ok(200)),
                cms(
                        "POST /api/v1/admin/posts/{id}/translations, someone else's post",
                        s -> withJson(
                                post(ADMIN_POSTS + "/" + s.adminDraft() + "/translations"), "{\"language\":\"en\"}"),
                        FORBIDDEN,
                        ok(201)),
                cms(
                        "POST /api/v1/admin/posts/{id}/translations, language that is not enabled",
                        s -> withJson(
                                post(ADMIN_POSTS + "/" + s.authorDraft() + "/translations"), "{\"language\":\"fr\"}"),
                        ok(400),
                        ok(400)),
                cms(
                        "PUT /api/v1/admin/posts/{id}/translations/{otherId}, the other post is someone else's",
                        s -> put(ADMIN_POSTS + "/" + s.authorDraft() + "/translations/" + s.adminDraft()),
                        FORBIDDEN,
                        ok(409)),
                cms(
                        "DELETE /api/v1/admin/posts/{id}/translations, someone else's post",
                        s -> delete(ADMIN_POSTS + "/" + s.adminDraft() + "/translations"),
                        FORBIDDEN,
                        ok(204)),
                // ADMIN only: series, gallery, comment moderation and users.
                adminOnly("GET /api/v1/admin/series", s -> get("/api/v1/admin/series"), ok(200)),
                adminOnly("GET /api/v1/admin/gallery", s -> get("/api/v1/admin/gallery"), ok(200)),
                adminOnly("GET /api/v1/admin/comments", s -> get("/api/v1/admin/comments"), ok(200)),
                adminOnly(
                        "PATCH /api/v1/admin/comments/{id}/status",
                        s -> withJson(patch(ADMIN_COMMENTS + s.othersComment() + "/status"), "{\"status\":\"HIDDEN\"}"),
                        ok(200)),
                adminOnly(
                        "DELETE /api/v1/admin/comments/{id}", s -> delete(ADMIN_COMMENTS + s.othersComment()), ok(204)),
                // Moderation filtered by post, the same rule as the list.
                adminOnly(
                        "GET /api/v1/admin/comments?postId=",
                        s -> get("/api/v1/admin/comments").param("postId", s.publishedId()),
                        ok(200)),
                // Merging tags and categories touches posts of every author, and the image quota belongs to the site:
                // ADMIN only.
                // Merge: an AUTHOR passes the URL rule /api/v1/admin/** and is then blocked by @PreAuthorize; quota:
                // the URL rule blocks.
                adminOnly(
                        "POST /api/v1/admin/tags/{id}/merge",
                        s -> withJson(post("/api/v1/admin/tags/" + s.newTag() + "/merge"), s.mergeInto(s.newTag())),
                        ok(200)),
                adminOnly(
                        "POST /api/v1/admin/categories/{id}/merge",
                        s -> withJson(
                                post("/api/v1/admin/categories/" + s.newCategory() + "/merge"),
                                s.mergeInto(s.newCategory())),
                        ok(200)),
                adminOnly("GET /api/v1/admin/media/usage", s -> get("/api/v1/admin/media/usage"), ok(200)),
                adminOnly("GET /api/v1/admin/users", s -> get("/api/v1/admin/users"), ok(200)),
                adminOnly(
                        "PATCH /api/v1/admin/users/{id}/status",
                        s -> withJson(patch(ADMIN_USERS + s.otherReader() + "/status"), "{\"status\":\"ACTIVE\"}"),
                        ok(200)),
                // Role change. The ADMIN cell sets the role it already has (200, nothing changes), because other people
                // use it
                // across the whole table.
                adminOnly(
                        "PATCH /api/v1/admin/users/{id}/role",
                        s -> withJson(patch(ADMIN_USERS + s.otherReader() + "/role"), "{\"role\":\"USER\"}"),
                        ok(200)),
                // Resetting an author's two-step verification: ADMIN only, and it needs the admin's recent sign-in
                // first.
                adminOnly(
                        "POST /api/v1/admin/users/{id}/mfa/reset",
                        s -> withJson(post(ADMIN_USERS + s.otherReader() + "/mfa/reset"), "{\"code\":\"123456\"}"),
                        REAUTHENTICATION_REQUIRED),
                // There is no user deletion path: ADMIN passes the URL rule and then no handler exists.
                adminOnly(
                        "DELETE /api/v1/admin/users/{id}, no such route",
                        s -> delete(ADMIN_USERS + s.otherReader()),
                        error(404, "ENDPOINT_NOT_FOUND")),
                // Author applications. Anyone can view their own application; only a reader can submit (the USER cell
                // is that account's only
                // submission in the table). Only ADMIN views the queue and decides, one new application per cell.
                signedIn("GET /api/v1/me/author-application", s -> get(MY_APPLICATION), ok(200)),
                row(
                        "POST /api/v1/me/author-application",
                        s -> withJson(post(MY_APPLICATION), "{\"motivation\":null}"),
                        UNAUTHENTICATED,
                        ok(201),
                        error(409, "AUTHOR_APPLICATION_NOT_ALLOWED"),
                        error(409, "AUTHOR_APPLICATION_NOT_ALLOWED")),
                adminOnly("GET /api/v1/admin/author-applications", s -> get(ADMIN_APPLICATIONS), ok(200)),
                // Approving makes a reader an author, a step-up (audit 111): the tokens of this matrix belong to
                // sessions that
                // started a day ago, so the administrator is asked to sign in again before any code is looked at.
                adminOnly(
                        "POST /api/v1/admin/author-applications/{id}/approve",
                        s -> post(ADMIN_APPLICATIONS + "/" + s.pendingApplication() + "/approve"),
                        REAUTHENTICATION_REQUIRED),
                adminOnly(
                        "POST /api/v1/admin/author-applications/{id}/reject",
                        s -> post(ADMIN_APPLICATIONS + "/" + s.pendingApplication() + "/reject"),
                        ok(200)),
                // Bookmarks of the caller, every role.
                signedIn("GET /api/v1/me/bookmarks", s -> get(BOOKMARKS), ok(200)),
                signedIn("GET /api/v1/me/bookmarks/{slug}", s -> get(s.bookmark()), ok(200)),
                signedIn("PUT /api/v1/me/bookmarks/{slug}", s -> put(s.bookmark()), ok(200)),
                signedIn("DELETE /api/v1/me/bookmarks/{slug}", s -> delete(s.bookmark()), ok(200)),
                // Newsletter. Three POSTs open to every caller, the authority of confirm and unsubscribe is the token;
                // each cell has its own address and
                // token, written directly with SQL. Figures ADMIN only; there is no public GET path.
                open(
                        "POST /api/v1/newsletter/subscriptions",
                        s -> withJson(post("/api/v1/newsletter/subscriptions"), s.newsletterSignup()),
                        ok(202)),
                open(
                        "POST /api/v1/newsletter/confirm",
                        s -> withJson(post("/api/v1/newsletter/confirm"), s.newsletterConfirmation()),
                        ok(200)),
                open(
                        "POST /api/v1/newsletter/unsubscribe",
                        s -> withJson(post("/api/v1/newsletter/unsubscribe"), s.newsletterUnsubscribe()),
                        ok(200)),
                adminOnly("GET /api/v1/admin/newsletter", s -> get("/api/v1/admin/newsletter"), ok(200)),
                // The newsletters of an AUTHOR's posts wait for an ADMIN. For the administrator these reach the service
                // and
                // stop at "not held" (404) or at the check of the version, which proves the authorization came first; a
                // reader or an author never gets that far.
                adminOnly("GET /api/v1/admin/newsletter/held", s -> get("/api/v1/admin/newsletter/held"), ok(200)),
                adminOnly(
                        "POST /api/v1/admin/newsletter/issues/{postId}/release",
                        s -> withJson(
                                post("/api/v1/admin/newsletter/issues/" + UUID.randomUUID() + "/release"),
                                "{\"version\":\"not-a-version\"}"),
                        error(404, "NEWSLETTER_ISSUE_NOT_FOUND")),
                adminOnly(
                        "POST /api/v1/admin/newsletter/issues/{postId}/discard",
                        s -> post("/api/v1/admin/newsletter/issues/" + UUID.randomUUID() + "/discard"),
                        error(404, "NEWSLETTER_ISSUE_NOT_FOUND")),
                // Releasing an old address of a renamed post is an ADMIN decision: an AUTHOR cannot free addresses.
                adminOnly(
                        "DELETE /api/v1/admin/slug-history/{slug}",
                        s -> delete("/api/v1/admin/slug-history/no-such-old-address-" + UUID.randomUUID()),
                        error(404, "SLUG_HISTORY_NOT_FOUND")),
                // Contact form: sending needs no login (each cell has its own address, the limit is per address); the
                // inbox is ADMIN only, never AUTHOR: it holds visitors' names, addresses and messages.
                open(
                        "POST /api/v1/contact/messages",
                        s -> withJson(post("/api/v1/contact/messages"), s.contactMessage()),
                        ok(202)),
                adminOnly("GET /api/v1/admin/contact/messages", s -> get("/api/v1/admin/contact/messages"), ok(200)),
                adminOnly(
                        "GET /api/v1/admin/contact/unread-count",
                        s -> get("/api/v1/admin/contact/unread-count"),
                        ok(200)),
                adminOnly(
                        "POST /api/v1/admin/contact/messages/{id}/read",
                        s -> post("/api/v1/admin/contact/messages/" + s.storedContactMessage() + "/read"),
                        ok(204)),
                adminOnly(
                        "DELETE /api/v1/admin/contact/messages/{id}",
                        s -> delete("/api/v1/admin/contact/messages/" + s.storedContactMessage()),
                        ok(204)),
                // Search maintenance is ADMIN only, never AUTHOR. The shared context has no MEILI_URL: a dry run
                // is still 200 (count only), a real run passes the authorization and stops at 409; both count toward
                // this admin's quota.
                adminOnly(
                        "POST /api/v1/admin/search/reindex?dryRun=true",
                        s -> post("/api/v1/admin/search/reindex").param("dryRun", "true"),
                        ok(200)),
                adminOnly(
                        "POST /api/v1/admin/search/reindex?dryRun=false",
                        s -> post("/api/v1/admin/search/reindex").param("dryRun", "false"),
                        error(409, "SEARCH_NOT_CONFIGURED")),
                adminOnly("GET /api/v1/admin/search/status", s -> get("/api/v1/admin/search/status"), ok(200)),
                adminOnly(
                        "GET /api/v1/admin/search/reindex, POST only",
                        s -> get("/api/v1/admin/search/reindex"),
                        error(405, "VALIDATION_ERROR")),
                // The owner's site content: the public read is open, every admin route is ADMIN only (never AUTHOR).
                // The
                // admin rows use requests that fail validation, so they prove the authorization without writing
                // anything.
                open("GET /api/v1/site-content", s -> get("/api/v1/site-content"), ok(200)),
                open(
                        "GET /api/v1/site-content?locale=fr",
                        s -> get("/api/v1/site-content").param("locale", "fr"),
                        error(400, "VALIDATION_ERROR")),
                adminOnly(
                        "GET /api/v1/admin/site-content?locale=vi",
                        s -> get("/api/v1/admin/site-content").param("locale", "vi"),
                        ok(200)),
                adminOnly(
                        "GET /api/v1/admin/site-content/{key}, unknown key",
                        s -> get("/api/v1/admin/site-content/nope").param("locale", "vi"),
                        error(400, "VALIDATION_ERROR")),
                adminOnly(
                        "PUT /api/v1/admin/site-content/{key}, unknown key",
                        s -> withJson(
                                put("/api/v1/admin/site-content/nope").param("locale", "vi"),
                                "{\"schemaVersion\":1,\"payload\":{}}"),
                        error(400, "VALIDATION_ERROR")),
                adminOnly(
                        "PUT /api/v1/admin/site-content/site, invalid payload",
                        s -> withJson(
                                put("/api/v1/admin/site-content/site").param("locale", "vi"),
                                "{\"schemaVersion\":1,\"payload\":{}}"),
                        error(400, "SITE_CONTENT_INVALID")),
                adminOnly(
                        "GET /api/v1/admin/site-content/{key}/revisions, unknown key",
                        s -> get("/api/v1/admin/site-content/nope/revisions").param("locale", "vi"),
                        error(400, "VALIDATION_ERROR")),
                adminOnly(
                        "POST /api/v1/admin/site-content/site/revisions/{id}/restore, no such revision",
                        s -> post("/api/v1/admin/site-content/site/revisions/999999999/restore")
                                .param("locale", "vi"),
                        error(404, "SITE_CONTENT_REVISION_NOT_FOUND")),
                adminOnly(
                        "GET /api/v1/admin/site-content/export?locale=vi",
                        s -> get("/api/v1/admin/site-content/export").param("locale", "vi"),
                        ok(200)),
                adminOnly(
                        "POST /api/v1/admin/site-content/import, wrong format",
                        s -> withJson(
                                post("/api/v1/admin/site-content/import"),
                                "{\"format\":\"nope\",\"formatVersion\":1,\"locale\":\"vi\",\"sections\":{}}"),
                        error(400, "SITE_CONTENT_INVALID")),
                // The Markdown profile import: ADMIN only. The write rows use a file that is refused (wrong name), so
                // they prove the authorization without writing anything.
                adminOnly(
                        "GET /api/v1/admin/site-import/template?locale=vi",
                        s -> get("/api/v1/admin/site-import/template").param("locale", "vi"),
                        ok(200)),
                adminOnly(
                        "GET /api/v1/admin/site-import/export?locale=vi",
                        s -> get("/api/v1/admin/site-import/export").param("locale", "vi"),
                        ok(200)),
                adminOnly(
                        "GET /api/v1/admin/site-import/status", s -> get("/api/v1/admin/site-import/status"), ok(200)),
                adminOnly(
                        "POST /api/v1/admin/site-import/preview, wrong file name",
                        s -> multipart("/api/v1/admin/site-import/preview")
                                .file(new MockMultipartFile("file", "profile.txt", "text/plain", "x".getBytes())),
                        error(400, "SITE_IMPORT_INVALID_FILE")),
                adminOnly(
                        "POST /api/v1/admin/site-import/apply, wrong file name",
                        s -> multipart("/api/v1/admin/site-import/apply")
                                .file(new MockMultipartFile("file", "profile.txt", "text/plain", "x".getBytes()))
                                .param("sha256", "0".repeat(64))
                                .param("mode", "update")
                                .param("sections", "identity"),
                        error(400, "SITE_IMPORT_INVALID_FILE")),
                adminOnly(
                        "DELETE /api/v1/admin/site-import/status, no such method",
                        s -> delete("/api/v1/admin/site-import/status"),
                        error(405, "VALIDATION_ERROR")),
                // The Markdown post import: ADMIN and AUTHOR (the CMS rule, not the ADMIN-only list), a reader is 403.
                // The write row uses a file that is refused (wrong name): it proves the authorization, writes nothing.
                cms(
                        "GET /api/v1/admin/post-import/template?language=vi",
                        s -> get("/api/v1/admin/post-import/template").param("language", "vi"),
                        ok(200),
                        ok(200)),
                cms(
                        "POST /api/v1/admin/post-import/preview, wrong file name",
                        s -> multipart("/api/v1/admin/post-import/preview")
                                .file(new MockMultipartFile("file", "post.txt", "text/plain", "x".getBytes())),
                        error(400, "POST_IMPORT_INVALID_FILE"),
                        error(400, "POST_IMPORT_INVALID_FILE")),
                cms(
                        "POST /api/v1/admin/post-import/article-preview, no file",
                        s -> multipart("/api/v1/admin/post-import/article-preview"),
                        error(400, "POST_IMPORT_INVALID_FILE"),
                        error(400, "POST_IMPORT_INVALID_FILE")),
                cms(
                        "GET /api/v1/admin/post-import/status",
                        s -> get("/api/v1/admin/post-import/status"),
                        ok(200),
                        ok(200)),
                cms(
                        "POST /api/v1/admin/post-import/apply, no files",
                        s -> multipart("/api/v1/admin/post-import/apply"),
                        error(400, "POST_IMPORT_INVALID_FILE"),
                        error(400, "POST_IMPORT_INVALID_FILE")),
                cms(
                        "DELETE /api/v1/admin/post-import/preview, no such method",
                        s -> delete("/api/v1/admin/post-import/preview"),
                        error(405, "VALIDATION_ERROR"),
                        error(405, "VALIDATION_ERROR")),
                // Loading the demo content is ADMIN only; the row uses a method the endpoint does not have, so it
                // proves
                // the URL rule without creating any post (SampleContentIT covers the write).
                adminOnly(
                        "DELETE /api/v1/admin/sample-content, no such method",
                        s -> delete("/api/v1/admin/sample-content"),
                        error(405, "VALIDATION_ERROR")),
                adminOnly(
                        "DELETE /api/v1/admin/site-content/site, no such method",
                        s -> delete("/api/v1/admin/site-content/site").param("locale", "vi"),
                        error(405, "VALIDATION_ERROR")),
                // First-run setup is a pre-auth route: the status is open, and a claim attempt on an instance that is
                // already
                // set up (this context links ADMIN_GITHUB_ID at startup) gets the same 404 whoever asks.
                open("GET /api/v1/setup/status", s -> get("/api/v1/setup/status"), ok(200)),
                open(
                        "POST /api/v1/setup, already completed",
                        s -> withJson(
                                post("/api/v1/setup"),
                                "{\"setupCode\":\"matrix-code-matrix-code-1\",\"email\":\"matrix@example.test\","
                                        + "\"password\":\"matrix-password-123\",\"displayName\":\"Matrix\"}"),
                        error(404, "SETUP_CLOSED")),
                denied("GET /api/v1/newsletter/subscriptions", s -> get("/api/v1/newsletter/subscriptions")),
                // Health and the API documentation.
                open("GET /api/v1/health", s -> get("/api/v1/health"), ok(200)),
                open("GET /v3/api-docs", s -> get("/v3/api-docs"), ok(200)),
                open("GET /swagger-ui/index.html", s -> get("/swagger-ui/index.html"), ok(200)),
                // Everything else falls to denyAll: unknown paths, and other methods or depths on exactly the existing
                // paths.
                denied("GET /api/v1/khong-co-duong-nay", s -> get("/api/v1/khong-co-duong-nay")),
                denied("GET /api/v1/comments/{id}", s -> get(COMMENTS + UUID.randomUUID())),
                denied("POST /api/v1/comments/{id}", s -> withJson(post(COMMENTS + UUID.randomUUID()), s.newContent())),
                denied(
                        "PATCH /api/v1/comments/{id}",
                        s -> withJson(patch(COMMENTS + UUID.randomUUID()), s.newContent())),
                denied(
                        "PUT /api/v1/comments/{id}/con",
                        s -> withJson(put(COMMENTS + UUID.randomUUID() + "/con"), s.newContent())),
                denied("DELETE /api/v1/comments/{id}/replies", s -> delete(COMMENTS + UUID.randomUUID() + "/replies")),
                denied("PUT /api/v1/posts/{slug}/comments", s -> withJson(put(s.post() + "/comments"), s.newContent())),
                denied("POST /api/v1/posts/{slug}/like", s -> post(s.post() + "/like")),
                // The old-slug lookup path has only GET.
                denied("POST /api/v1/posts/{slug}/redirect", s -> post(s.movedPost() + "/redirect")),
                // There is no GET for comment likes, and no other write path into notifications.
                denied("GET /api/v1/comments/{id}/like", s -> get(COMMENTS + UUID.randomUUID() + "/like")),
                denied("POST /api/v1/comments/{id}/like", s -> post(COMMENTS + UUID.randomUUID() + "/like")),
                denied("POST /api/v1/notifications", s -> post(NOTIFICATIONS)),
                denied("DELETE /api/v1/notifications", s -> delete(NOTIFICATIONS)),
                denied("GET /api/v1/notifications/{id}", s -> get(NOTIFICATIONS + "/" + UUID.randomUUID())),
                denied(
                        "PATCH /api/v1/notifications/{id}",
                        s -> withJson(patch(NOTIFICATIONS + "/" + UUID.randomUUID()), "{\"read\":true}")),
                denied(
                        "PUT /api/v1/notifications/{id}/read",
                        s -> put(NOTIFICATIONS + "/" + UUID.randomUUID() + "/read")),
                denied(
                        "DELETE /api/v1/notifications/{id}/read",
                        s -> delete(NOTIFICATIONS + "/" + UUID.randomUUID() + "/read")),
                denied("GET /api/v1/notifications/read-all", s -> get(NOTIFICATIONS + "/read-all")),
                // There is no cancelling or editing an application.
                denied("DELETE /api/v1/me/author-application", s -> delete(MY_APPLICATION)),
                // Bookmarks have only the four paths above; no POST, no unsave-all.
                denied("POST /api/v1/me/bookmarks/{slug}", s -> post(s.bookmark())),
                denied("DELETE /api/v1/me/bookmarks", s -> delete(BOOKMARKS)),
                // There is no public user list, no write path, and no deeper path under a profile.
                denied("GET /api/v1/users", s -> get("/api/v1/users")),
                denied("GET /api/v1/users/{slug}/posts", s -> get(s.profile() + "/posts")),
                denied("POST /api/v1/users/{slug}", s -> withJson(post(s.profile()), "{\"displayName\":\"x\"}")),
                denied("PUT /api/v1/users/{slug}", s -> withJson(put(s.profile()), "{\"displayName\":\"x\"}")),
                denied("PATCH /api/v1/users/{slug}", s -> withJson(patch(s.profile()), "{\"displayName\":\"x\"}")),
                denied("DELETE /api/v1/users/{slug}", s -> delete(s.profile())),
                // Search has only GET.
                denied("POST /api/v1/search", s -> withJson(post("/api/v1/search"), "{\"q\":\"matrix\"}")));
    }

    @ParameterizedTest(name = "{0} — {1} → {2}")
    @MethodSource("matrix")
    void authorization_table_C1(String row, Caller caller, Expect expect, Call call) throws Exception {
        Scene scene = new Scene(caller);
        MockHttpServletResponse response = call(call.build(scene), scene.bearer());

        String body = response.getContentAsString(StandardCharsets.UTF_8);
        assertThat(response.getStatus()).as("%s — %s: %s", row, caller, body).isEqualTo(expect.status());
        if (expect.code() != null) {
            assertThat(objectMapper.readTree(body).path("error").path("code").asString())
                    .as(body)
                    .isEqualTo(expect.code());
        }
    }

    // --- The points the table only notes ---------------------------------------------------------------

    @Test
    void suspended_reader_can_still_read_but_auth_me_and_every_write_is_403_USER_SUSPENDED() throws Exception {
        User suspended =
                auth.createReader(auth.nextGithubId(), "ma-tran-bi-khoa-" + fixtures.suffix, UserStatus.SUSPENDED);
        String bearer = auth.bearerFor(suspended);
        UUID own = fixtures.insertComment(
                published, suspended.getId(), null, "Written before the suspension", "VISIBLE", Instant.now());
        UUID others = fixtures.insertComment(published, other.id(), null, "Of someone else", "VISIBLE", Instant.now());
        String content = "{\"content\":\"Suspended but still tries to write\"}";

        assertError(call(get(ME), bearer), 403, "USER_SUSPENDED");
        assertError(call(withJson(post(postPath(published) + "/comments"), content), bearer), 403, "USER_SUSPENDED");
        assertError(call(withJson(post(COMMENTS + others + "/replies"), content), bearer), 403, "USER_SUSPENDED");
        assertError(call(withJson(put(COMMENTS + own), content), bearer), 403, "USER_SUSPENDED");
        assertError(call(delete(COMMENTS + own), bearer), 403, "USER_SUSPENDED");
        assertError(call(put(postPath(published) + "/like"), bearer), 403, "USER_SUSPENDED");
        assertError(call(delete(postPath(published) + "/like"), bearer), 403, "USER_SUSPENDED");
        assertError(call(put(COMMENTS + others + "/like"), bearer), 403, "USER_SUSPENDED");
        assertError(call(delete(COMMENTS + others + "/like"), bearer), 403, "USER_SUSPENDED");
        // The notification inbox belongs to the account, it is not public data: even reading is 403.
        UUID notification = fixtures.insertNotification(
                suspended.getId(), other.id(), "POST_COMMENTED", published, others, Instant.now());
        assertError(call(get(NOTIFICATIONS), bearer), 403, "USER_SUSPENDED");
        assertError(call(get(NOTIFICATIONS + "/unread-count"), bearer), 403, "USER_SUSPENDED");
        assertError(call(post(NOTIFICATIONS + "/" + notification + "/read"), bearer), 403, "USER_SUSPENDED");
        assertError(call(post(NOTIFICATIONS + "/read-all"), bearer), 403, "USER_SUSPENDED");
        assertError(call(delete(NOTIFICATIONS + "/" + notification), bearer), 403, "USER_SUSPENDED");
        // The same for author applications: cannot be submitted, cannot be viewed.
        assertError(call(get(MY_APPLICATION), bearer), 403, "USER_SUSPENDED");
        assertError(
                call(withJson(post(MY_APPLICATION), "{\"motivation\":\"Suspended but still applies\"}"), bearer),
                403,
                "USER_SUSPENDED");

        // Public reads still work, the account status is not checked (UserSuspensionIT checks mine and liked); the
        // admin area is still
        // a matter of role.
        assertThat(call(get(postPath(published) + "/comments"), bearer).getStatus())
                .isEqualTo(200);
        assertThat(call(get(postPath(published) + "/like"), bearer).getStatus()).isEqualTo(200);
        assertError(call(get("/api/v1/admin/posts"), bearer), 403, "FORBIDDEN");

        // No write gets through.
        assertThat(count("SELECT count(*) FROM comments WHERE user_id = ?", suspended.getId()))
                .isEqualTo(1);
        assertThat(fixtures.row(own).get("status")).isEqualTo("VISIBLE");
        assertThat(fixtures.row(own).get("content")).isEqualTo("Written before the suspension");
        assertThat(count("SELECT count(*) FROM post_likes WHERE user_id = ?", suspended.getId()))
                .isZero();
        assertThat(count("SELECT count(*) FROM comment_likes WHERE user_id = ?", suspended.getId()))
                .isZero();
        assertThat(count("SELECT count(*) FROM notifications WHERE id = ? AND read_at IS NULL", notification))
                .isEqualTo(1);
        assertThat(count("SELECT count(*) FROM author_applications WHERE user_id = ?", suspended.getId()))
                .isZero();
    }

    @Test
    void only_ADMIN_can_change_roles_auth_me_has_no_write_method_and_role_in_status_path_body_is_ignored()
            throws Exception {
        User reader = auth.createReader(auth.nextGithubId(), "ma-tran-vai-tro-" + fixtures.suffix);
        String bearer = auth.bearerFor(reader);
        String promote = "{\"role\":\"ADMIN\",\"status\":\"ACTIVE\"}";

        // /auth/me has only GET: PATCH, PUT or POST pass the URL rule (any valid token) and then no handler exists.
        assertError(call(withJson(patch(ME), promote), bearer), 405, "VALIDATION_ERROR");
        assertError(call(withJson(put(ME), promote), bearer), 405, "VALIDATION_ERROR");
        assertError(call(withJson(post(ME), promote), bearer), 405, "VALIDATION_ERROR");

        // The role change path belongs to ADMIN: a reader promoting themselves gets 403 at the URL rule.
        assertError(call(withJson(patch(ADMIN_USERS + reader.getId() + "/role"), promote), bearer), 403, "FORBIDDEN");

        // The admin status PATCH: a reader cannot enter, while an admin can but the body is read only for the status
        // field.
        String statusPath = ADMIN_USERS + reader.getId() + "/status";
        assertError(call(withJson(patch(statusPath), promote), bearer), 403, "FORBIDDEN");
        MockHttpServletResponse byAdmin = call(withJson(patch(statusPath), promote), admin.bearer());
        assertThat(byAdmin.getStatus()).as(byAdmin.getContentAsString()).isEqualTo(200);
        assertThat(data(byAdmin).path("role").asString()).isEqualTo("USER");

        assertThat(jdbcTemplate.queryForObject("SELECT role FROM users WHERE id = ?", String.class, reader.getId()))
                .isEqualTo("USER");
        MockHttpServletResponse me = call(get(ME), bearer);
        assertThat(me.getStatus()).isEqualTo(200);
        assertThat(data(me).path("role").asString()).isEqualTo("USER");
        assertError(call(get("/api/v1/admin/posts"), bearer), 403, "FORBIDDEN");
    }

    @Test
    void user_id_in_body_or_query_is_ignored_and_writer_is_always_the_token_owner() throws Exception {
        User caller = auth.createReader(auth.nextGithubId(), "ma-tran-that-" + fixtures.suffix);
        User victim = auth.createReader(auth.nextGithubId(), "ma-tran-nan-nhan-" + fixtures.suffix);
        String bearer = auth.bearerFor(caller);
        String victimId = victim.getId().toString();
        UUID victimComment =
                fixtures.insertComment(published, victim.getId(), null, "Of the victim", "VISIBLE", Instant.now());

        // Create and reply "in the name of" the victim: the comment still belongs to the token owner.
        MockHttpServletResponse created = call(
                withJson(
                        post(postPath(published) + "/comments").queryParam("userId", victimId),
                        forged(victimId, "Written as someone else")),
                bearer);
        assertThat(created.getStatus()).as(created.getContentAsString()).isEqualTo(201);
        assertThat(data(created).path("mine").asBoolean()).isTrue();
        assertThat(data(created).path("author").path("githubLogin").asString()).isEqualTo(caller.getGithubLogin());
        assertThat(fixtures.row(id(created)).get("user_id")).isEqualTo(caller.getId());

        MockHttpServletResponse replied = call(
                withJson(
                        post(COMMENTS + victimComment + "/replies").queryParam("userId", victimId),
                        forged(victimId, "Reply as someone else")),
                bearer);
        assertThat(replied.getStatus()).as(replied.getContentAsString()).isEqualTo(201);
        assertThat(fixtures.row(id(replied)).get("user_id")).isEqualTo(caller.getId());

        // Edit and delete the victim's comment while claiming to be the victim: still another person, 403, nothing
        // changes.
        assertError(
                call(
                        withJson(
                                put(COMMENTS + victimComment).queryParam("userId", victimId),
                                forged(victimId, "Edit on behalf of the victim")),
                        bearer),
                403,
                "FORBIDDEN");
        assertError(call(delete(COMMENTS + victimComment).queryParam("userId", victimId), bearer), 403, "FORBIDDEN");
        assertThat(fixtures.row(victimComment).get("content")).isEqualTo("Of the victim");
        assertThat(fixtures.row(victimComment).get("status")).isEqualTo("VISIBLE");

        // Like and unlike: always the token owner's like.
        jdbcTemplate.update("INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)", published.id(), victim.getId());
        MockHttpServletResponse liked = call(
                withJson(put(postPath(published) + "/like").queryParam("userId", victimId), forged(victimId, "")),
                bearer);
        assertThat(liked.getStatus()).as(liked.getContentAsString()).isEqualTo(200);
        assertThat(data(liked).path("liked").asBoolean()).isTrue();
        assertThat(likes(caller)).isEqualTo(1);
        MockHttpServletResponse unliked =
                call(delete(postPath(published) + "/like").queryParam("userId", victimId), bearer);
        assertThat(unliked.getStatus()).as(unliked.getContentAsString()).isEqualTo(200);
        assertThat(likes(caller)).isZero();
        assertThat(likes(victim))
                .as("the victim's like was not removed by someone else")
                .isEqualTo(1);
    }

    @Test
    void token_self_signed_with_other_key_carrying_admin_id_and_role_is_401_on_every_main_chain_path_even_public_reads()
            throws Exception {
        String forged = "Bearer " + foreignSignedToken(admin.id(), "ADMIN");

        assertError(call(get(ME), forged), 401, "UNAUTHENTICATED");
        assertError(call(get("/api/v1/admin/users"), forged), 401, "UNAUTHENTICATED");
        assertError(
                call(withJson(patch(ADMIN_USERS + other.id() + "/status"), "{\"status\":\"SUSPENDED\"}"), forged),
                401,
                "UNAUTHENTICATED");
        assertError(
                call(withJson(post(postPath(published) + "/comments"), "{\"content\":\"Forged token\"}"), forged),
                401,
                "UNAUTHENTICATED");
        // A token that is present must be valid, even on an open read path: the bearer filter runs before the URL rule.
        // Next knows this:
        // an optional-login GET that gets 401 is retried without a token.
        assertError(call(get(postPath(published) + "/comments"), forged), 401, "UNAUTHENTICATED");

        assertThat(jdbcTemplate.queryForObject("SELECT status FROM users WHERE id = ?", String.class, other.id()))
                .isEqualTo("ACTIVE");

        // Contrast: the token-issuing chain (@Order(1)) has no bearer filter, so a fake header is ignored, not
        // rejected.
        // Logout relies only on the refresh token in the body, and still revokes it.
        String refreshToken = auth.verifiedRefreshToken(loginUser);
        MockHttpServletResponse logout = call(
                withJson(
                        post("/api/v1/auth/logout"),
                        objectMapper.writeValueAsString(Map.of("refreshToken", refreshToken))),
                forged);
        assertThat(logout.getStatus()).as(logout.getContentAsString()).isEqualTo(204);
        assertError(
                call(
                        withJson(
                                post("/api/v1/auth/refresh"),
                                objectMapper.writeValueAsString(Map.of("refreshToken", refreshToken))),
                        null),
                401,
                "REFRESH_TOKEN_REVOKED");
    }

    @Test
    void comment_reads_and_likes_mine_and_liked_are_true_only_for_the_token_owner() throws Exception {
        Post post = fixtures.publishedPost("Post for mine and liked");
        UUID usersComment = fixtures.insertComment(post, user.id(), null, "Of USER", "VISIBLE", Instant.now());
        UUID othersComment =
                fixtures.insertComment(post, other.id(), null, "Of someone else", "VISIBLE", Instant.now());
        jdbcTemplate.update("INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)", post.id(), user.id());
        jdbcTemplate.update("INSERT INTO comment_likes (comment_id, user_id) VALUES (?, ?)", othersComment, user.id());

        assertThat(mineFlags(post, null))
                .containsExactlyInAnyOrderEntriesOf(Map.of(usersComment, false, othersComment, false));
        assertThat(mineFlags(post, user.bearer()))
                .containsExactlyInAnyOrderEntriesOf(Map.of(usersComment, true, othersComment, false));
        assertThat(mineFlags(post, author.bearer()))
                .containsExactlyInAnyOrderEntriesOf(Map.of(usersComment, false, othersComment, false));
        assertThat(mineFlags(post, admin.bearer()))
                .containsExactlyInAnyOrderEntriesOf(Map.of(usersComment, false, othersComment, false));
        // likedByMe works the same way: true only for the person who liked.
        assertThat(likedFlags(post, null))
                .containsExactlyInAnyOrderEntriesOf(Map.of(usersComment, false, othersComment, false));
        assertThat(likedFlags(post, user.bearer()))
                .containsExactlyInAnyOrderEntriesOf(Map.of(usersComment, false, othersComment, true));
        assertThat(likedFlags(post, other.bearer()))
                .containsExactlyInAnyOrderEntriesOf(Map.of(usersComment, false, othersComment, false));
        assertThat(likedFlags(post, admin.bearer()))
                .containsExactlyInAnyOrderEntriesOf(Map.of(usersComment, false, othersComment, false));

        assertLike(post, null, false);
        assertLike(post, user.bearer(), true);
        assertLike(post, author.bearer(), false);
        assertLike(post, admin.bearer(), false);
    }

    // --- One call of the table -------------------------------------------------------------------------

    /**
     * The data of one cell: the caller, and the comments created just for that cell with SQL (spending nobody's rate limit).
     */
    final class Scene {

        private final Account caller;
        private final String tag;

        Scene(Caller who) {
            caller = switch (who) {
                case ANONYMOUS -> null;
                case USER -> user;
                case AUTHOR -> author;
                case ADMIN -> admin;
            };
            tag = who.name().toLowerCase(Locale.ROOT) + " "
                    + UUID.randomUUID().toString().substring(0, 8);
        }

        String bearer() {
            return caller == null ? null : caller.bearer();
        }

        String post() {
            return postPath(published);
        }

        String bookmark() {
            return BOOKMARKS + "/" + published.slug();
        }

        String profileSlug() {
            return userSlug;
        }

        String profile() {
            return "/api/v1/users/" + userSlug;
        }

        /** The old-slug path: a post whose slug changed after it was published. */
        String movedPost() {
            return "/api/v1/posts/" + movedSlug;
        }

        String coverFile() {
            return coverFile;
        }

        UUID authorDraft() {
            return authorDraft;
        }

        UUID adminDraft() {
            return adminDraft;
        }

        UUID otherReader() {
            return other.id();
        }

        /**
         * A new root comment of the caller themself. An anonymous caller has no comment: take another person's,
         * the call is 401 before reaching it anyway.
         */
        UUID ownComment() {
            return comment(caller == null ? other : caller);
        }

        UUID othersComment() {
            return comment(other);
        }

        /**
         * A new notification sent to the caller (another person commented on a post): written directly with SQL, as the real insert
         * would write it. An anonymous caller has no notification inbox: a nonexistent id, the call is 401 before
         * reaching it anyway.
         */
        UUID ownNotification() {
            return caller == null ? UUID.randomUUID() : notification(caller, other);
        }

        /** A notification of another person, caused by the caller (or by the USER, when the caller is anonymous). */
        UUID othersNotification() {
            return notification(other, caller == null ? user : caller);
        }

        private UUID notification(Account recipient, Account actor) {
            return fixtures.insertNotification(
                    recipient.id(), actor.id(), "POST_COMMENTED", published, comment(actor), Instant.now());
        }

        String newContent() {
            return objectMapper.writeValueAsString(Map.of("content", "Comment of the permission matrix, " + tag));
        }

        String loginBody() {
            return objectMapper.writeValueAsString(Map.of("email", loginUser.getEmail(), "password", LOGIN_PASSWORD));
        }

        /** A new, live refresh token of an account with a password. */
        String refreshBody() {
            return objectMapper.writeValueAsString(Map.of("refreshToken", auth.verifiedRefreshToken(loginUser)));
        }

        String newDraft() {
            return objectMapper.writeValueAsString(
                    Map.of("title", "Draft from the permission matrix, " + tag, "content", "Draft content"));
        }

        String duplicateOrder() {
            return objectMapper.writeValueAsString(
                    Map.of("postIds", List.of(authorDraft.toString(), authorDraft.toString())));
        }

        String publishedId() {
            return published.id().toString();
        }

        /** Uploads a real PNG image into the post body: when the call is accepted the image goes through exactly the cover image pipeline. */
        AbstractMockHttpServletRequestBuilder<?> imageUpload(UUID postId) {
            return multipart(ADMIN_POSTS + "/" + postId + "/images")
                    .file(new MockMultipartFile("file", "opaque.png", "image/png", png));
        }

        /** A new image in the post body, written directly with SQL (a metadata row is enough to delete). */
        UUID bodyImage(UUID postId) {
            UUID id = UUID.randomUUID();
            jdbcTemplate.update("""
                    INSERT INTO media (id, content_type, width, height, byte_size, sha256, post_id)
                    VALUES (?, 'image/png', 1, 1, 1, ?, ?)""", id, "0".repeat(64), postId);
            return id;
        }

        /** A new revision of the post, written directly with SQL the way PostRevisionService writes it. */
        UUID revision(UUID postId) {
            UUID id = UUID.randomUUID();
            jdbcTemplate.update(
                    "INSERT INTO post_revisions (id, post_id, title, content) VALUES (?, ?, ?, ?)",
                    id,
                    postId,
                    "Old version of the matrix, " + tag,
                    "Old content of the matrix, " + tag);
            return id;
        }

        UUID newTag() {
            UUID id = UUID.randomUUID();
            jdbcTemplate.update(
                    "INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)", id, "Matrix tag " + id, "the-ma-tran-" + id);
            return id;
        }

        UUID newCategory() {
            UUID id = UUID.randomUUID();
            jdbcTemplate.update(
                    "INSERT INTO categories (id, name, slug) VALUES (?, ?, ?)",
                    id,
                    "Matrix category " + id,
                    "chuyen-muc-ma-tran-" + id);
            return id;
        }

        String mergeInto(UUID target) {
            return objectMapper.writeValueAsString(Map.of("targetId", target.toString()));
        }

        /** A valid contact form body for this cell: its own address, so the per-address limit is never reached. */
        String contactMessage() {
            return objectMapper.writeValueAsString(Map.of(
                    "name",
                    "Matrix visitor",
                    "email",
                    "ma-tran-lien-he-" + UUID.randomUUID() + "@example.com",
                    "message",
                    "A message from the security matrix, " + tag));
        }

        /** A stored contact message, written directly with SQL: the ADMIN cell reads or deletes it. */
        UUID storedContactMessage() {
            UUID id = UUID.randomUUID();
            jdbcTemplate.update(
                    "INSERT INTO contact_messages (id, name, email, message) VALUES (?, ?, ?, ?)",
                    id,
                    "Matrix visitor",
                    "ma-tran-" + id + "@example.com",
                    "A stored message of the security matrix");
            return id;
        }

        /** A new newsletter address for this cell. */
        String newsletterSignup() {
            return objectMapper.writeValueAsString(Map.of("email", newsletterAddress("dang-ky")));
        }

        /** A pending subscription with a still-valid confirmation token, written as the worker writes it (hash only); returns the request body. */
        String newsletterConfirmation() {
            String token = NewsletterTokens.newConfirmationToken();
            jdbcTemplate.update("""
                    INSERT INTO newsletter_subscribers (email, status, confirmation_requested_at, confirmation_sent_at,
                        confirmation_token_hash, confirmation_expires_at)
                    VALUES (?, 'PENDING', now(), now(), ?, now() + interval '1 day')""", newsletterAddress("xac-nhan"), NewsletterTokens.sha256Hex(token));
            return objectMapper.writeValueAsString(Map.of("token", token));
        }

        /** A confirmed person, and the unsubscribe token in their mail. */
        String newsletterUnsubscribe() {
            UUID id = UUID.randomUUID();
            jdbcTemplate.update("""
                    INSERT INTO newsletter_subscribers (id, email, status, confirmed_at)
                    VALUES (?, ?, 'CONFIRMED', now())""", id, newsletterAddress("huy"));
            return objectMapper.writeValueAsString(Map.of("token", newsletterTokens.unsubscribeToken(id)));
        }

        private String newsletterAddress(String stem) {
            return "ma-tran-" + stem + "-" + tag.replace(' ', '-') + "@example.com";
        }

        /** A PENDING application of a new reader, written directly with SQL: the ADMIN cell approves or rejects it. */
        UUID pendingApplication() {
            User applicant = auth.createReader(auth.nextGithubId(), "ma-tran-don-" + tag.replace(' ', '-'));
            UUID id = UUID.randomUUID();
            jdbcTemplate.update("INSERT INTO author_applications (id, user_id) VALUES (?, ?)", id, applicant.getId());
            return id;
        }

        private UUID comment(Account by) {
            return fixtures.insertComment(
                    published, by.id(), null, "Existing comment, " + tag, "VISIBLE", Instant.now());
        }
    }

    // --- Building the table ----------------------------------------------------------------------------

    private static Expect ok(int status) {
        return new Expect(status, null);
    }

    private static Expect error(int status, String code) {
        return new Expect(status, code);
    }

    /** Open to every caller, the same answer. */
    private static Row open(String name, Call call, Expect everyone) {
        return row(name, call, everyone, everyone, everyone, everyone);
    }

    /** Login required, every role (reader writes, /auth/me). */
    private static Row signedIn(String name, Call call, Expect signedIn) {
        return row(name, call, UNAUTHENTICATED, signedIn, signedIn, signedIn);
    }

    /** The CMS area ({@code /api/v1/admin/**} except the ADMIN-only part): a USER is blocked by the URL rule. */
    private static Row cms(String name, Call call, Expect author, Expect admin) {
        return row(name, call, UNAUTHENTICATED, FORBIDDEN, author, admin);
    }

    /** Managing two-step verification: ADMIN and AUTHOR may try (and need a recent sign-in); a USER is stopped by the URL rule. */
    private static Row managesMfa(String name, Call call) {
        return row(name, call, UNAUTHENTICATED, FORBIDDEN, REAUTHENTICATION_REQUIRED, REAUTHENTICATION_REQUIRED);
    }

    private static Row adminOnly(String name, Call call, Expect admin) {
        return row(name, call, UNAUTHENTICATED, FORBIDDEN, FORBIDDEN, admin);
    }

    /** No rule matches: denyAll, 401 without a token and 403 for every role. */
    private static Row denied(String name, Call call) {
        return adminOnly(name, call, FORBIDDEN);
    }

    private static Row row(String name, Call call, Expect anonymous, Expect user, Expect author, Expect admin) {
        Map<Caller, Expect> expected = new EnumMap<>(Caller.class);
        expected.put(Caller.ANONYMOUS, anonymous);
        expected.put(Caller.USER, user);
        expected.put(Caller.AUTHOR, author);
        expected.put(Caller.ADMIN, admin);
        return new Row(name, call, expected);
    }

    private static MockHttpServletRequestBuilder withJson(MockHttpServletRequestBuilder request, String body) {
        return request.contentType(APPLICATION_JSON).content(body);
    }

    private static String postPath(Post post) {
        return "/api/v1/posts/" + post.slug();
    }

    // --- Helpers ---------------------------------------------------------------------------------------

    private Account account(User user) {
        return new Account(
                user.getId(), auth.bearerForSessionStartedAt(user, Instant.now().minus(1, ChronoUnit.DAYS)));
    }

    private UUID createDraft(Account by, String title) throws Exception {
        String payload = objectMapper.writeValueAsString(Map.of("title", title, "content", "Draft content"));
        MockHttpServletResponse response = call(withJson(post(ADMIN_POSTS), payload), by.bearer());
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(201);
        return id(response);
    }

    /** Changes the slug of a post with a full PUT (this class's ADMIN), keeping the title, content and category. */
    private void renameSlug(Post post, String slug) throws Exception {
        MockHttpServletResponse current = call(get(ADMIN_POSTS + "/" + post.id()), admin.bearer());
        assertThat(current.getStatus()).as(current.getContentAsString()).isEqualTo(200);
        JsonNode data = data(current);
        String body = objectMapper.writeValueAsString(Map.of(
                "title", data.path("title").asString(),
                "content", data.path("content").asString(),
                "categoryId", data.path("category").path("id").asString(),
                "slug", slug));
        MockHttpServletResponse renamed = call(withJson(put(ADMIN_POSTS + "/" + post.id()), body), admin.bearer());
        assertThat(renamed.getStatus()).as(renamed.getContentAsString()).isEqualTo(200);
        assertThat(data(renamed).path("slug").asString()).isEqualTo(slug);
    }

    /** Uploads a cover image to a draft; returns the public file name of the image ({@code <uuid>.png}). */
    private String uploadCover(Account by, UUID postId) throws Exception {
        MockHttpServletResponse response = mockMvc.perform(multipart(ADMIN_POSTS + "/" + postId + "/cover")
                        .file(new MockMultipartFile("file", "opaque.png", "image/png", png))
                        .header("Authorization", by.bearer()))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse();
        return data(response).path("cover").path("fileName").asString();
    }

    private MockHttpServletResponse call(AbstractMockHttpServletRequestBuilder<?> request, String bearer)
            throws Exception {
        if (bearer != null) {
            request.header("Authorization", bearer);
        }
        return mockMvc.perform(request).andReturn().getResponse();
    }

    /** The body of a create, reply, edit or like that also carries every way of claiming to be someone else. */
    private String forged(String victimId, String content) {
        Map<String, Object> body = new HashMap<>(
                Map.of("userId", victimId, "authorId", victimId, "user", Map.of("id", victimId), "role", "ADMIN"));
        if (!content.isEmpty()) {
            body.put("content", content + " " + fixtures.suffix);
        }
        return objectMapper.writeValueAsString(body);
    }

    /** A token shaped exactly like TokenService's, signed with a key the application does not trust. */
    private static String foreignSignedToken(UUID subject, String role) {
        SecretKeySpec foreignKey = new SecretKeySpec(
                "khoa-cua-ke-mao-danh-dai-it-nhat-ba-muoi-hai-byte".getBytes(StandardCharsets.UTF_8), "HmacSHA256");
        Instant now = Instant.now();
        return NimbusJwtEncoder.withSecretKey(foreignKey)
                .build()
                .encode(JwtEncoderParameters.from(
                        JwsHeader.with(() -> "HS256").build(),
                        JwtClaimsSet.builder()
                                .subject(subject.toString())
                                .issuedAt(now)
                                .expiresAt(now.plusSeconds(900))
                                .claim("role", role)
                                .build()))
                .getTokenValue();
    }

    /** The {@code mine} of each root comment on the first page, read with a given token (null is anonymous). */
    private Map<UUID, Boolean> mineFlags(Post post, String bearer) throws Exception {
        return flags(post, bearer, "mine");
    }

    /** The {@code likedByMe} of each root comment on the first page, read with a given token (null is anonymous). */
    private Map<UUID, Boolean> likedFlags(Post post, String bearer) throws Exception {
        return flags(post, bearer, "likedByMe");
    }

    private Map<UUID, Boolean> flags(Post post, String bearer, String field) throws Exception {
        MockHttpServletResponse response = call(get(postPath(post) + "/comments"), bearer);
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
        Map<UUID, Boolean> flags = new LinkedHashMap<>();
        for (JsonNode thread : data(response).path("threads")) {
            JsonNode comment = thread.path("comment");
            flags.put(
                    UUID.fromString(comment.path("id").asString()),
                    comment.path(field).asBoolean());
        }
        return flags;
    }

    private void assertLike(Post post, String bearer, boolean liked) throws Exception {
        MockHttpServletResponse response = call(get(postPath(post) + "/like"), bearer);
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
        assertThat(data(response).path("liked").asBoolean()).isEqualTo(liked);
        assertThat(data(response).path("count").asLong()).isEqualTo(1);
    }

    private long likes(User user) {
        return count("SELECT count(*) FROM post_likes WHERE post_id = ? AND user_id = ?", published.id(), user.getId());
    }

    private long count(String sql, Object... args) {
        return jdbcTemplate.queryForObject(sql, Long.class, args);
    }

    private JsonNode data(MockHttpServletResponse response) throws Exception {
        return objectMapper
                .readTree(response.getContentAsString(StandardCharsets.UTF_8))
                .path("data");
    }

    private UUID id(MockHttpServletResponse response) throws Exception {
        return UUID.fromString(data(response).path("id").asString());
    }

    private void assertError(MockHttpServletResponse response, int status, String code) throws Exception {
        String body = response.getContentAsString(StandardCharsets.UTF_8);
        assertThat(response.getStatus()).as(body).isEqualTo(status);
        assertThat(objectMapper.readTree(body).path("error").path("code").asString())
                .as(body)
                .isEqualTo(code);
    }
}
