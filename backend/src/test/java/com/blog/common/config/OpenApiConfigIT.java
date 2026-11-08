package com.blog.common.config;

import static java.util.Map.entry;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.fail;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.http.MediaType.MULTIPART_FORM_DATA_VALUE;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.comment.CommentFixtures;
import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.common.exception.ErrorCode;
import com.blog.newsletter.service.NewsletterTokens;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.HttpMethod;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerExecutionChain;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;
import org.springframework.web.util.ServletRequestPathUtils;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The OpenAPI document ({@code /v3/api-docs}) checked against the running application itself, per the requirement that the "schema must reflect the real response,
 * and not declare an API that does not exist":
 * <ul>
 *   <li>every operation in the document has a real handler, and the two GitHub login paths (filters, not an API) are absent;</li>
 *   <li>an operation the document declares as needing a token makes the real filter chain return 401 without a token, and an operation that does not declare
 *       one does not: every operation is called for real, so the table in OpenApiConfig cannot drift from SecurityConfig;</li>
 *   <li>the real answers of the reader-account and auth endpoints, success and error alike, match field by field the schema the document declares for
 *       exactly that status code: the exact field set, the right type, null only in fields declared nullable, values inside the enum.</li>
 * </ul>
 *
 * The {@code /__test/**} paths (TestExceptionController, present only in the test context) are skipped: they are not in the document
 * of the real application. Every account belongs to a single test (rate limits are per person, in the memory of the shared context).
 */
@AutoConfigureMockMvc
class OpenApiConfigIT extends AbstractIntegrationTest {

    private static final String COMMENTS_OF_POST = "/api/v1/posts/{slug}/comments";
    private static final String REPLIES = "/api/v1/comments/{id}/replies";
    private static final String COMMENT = "/api/v1/comments/{id}";
    private static final String LIKE = "/api/v1/posts/{slug}/like";
    private static final String COMMENT_LIKE = "/api/v1/comments/{id}/like";
    private static final String NOTIFICATIONS = "/api/v1/notifications";
    private static final String UNREAD_COUNT = "/api/v1/notifications/unread-count";
    private static final String NOTIFICATION_READ = "/api/v1/notifications/{id}/read";
    private static final String READ_ALL = "/api/v1/notifications/read-all";
    private static final String NOTIFICATION = "/api/v1/notifications/{id}";
    private static final String ME = "/api/v1/auth/me";
    private static final String ADMIN_COMMENTS = "/api/v1/admin/comments";
    private static final String ADMIN_COMMENT_STATUS = "/api/v1/admin/comments/{id}/status";
    private static final String ADMIN_COMMENT = "/api/v1/admin/comments/{id}";
    private static final String ADMIN_USERS = "/api/v1/admin/users";
    private static final String ADMIN_USER_STATUS = "/api/v1/admin/users/{id}/status";
    private static final String ADMIN_USER_ROLE = "/api/v1/admin/users/{id}/role";
    private static final String REDIRECT = "/api/v1/posts/{slug}/redirect";
    private static final String POST_IMAGES = "/api/v1/admin/posts/{id}/images";
    private static final String POST_IMAGE = "/api/v1/admin/posts/{id}/images/{mediaId}";
    private static final String REVISIONS = "/api/v1/admin/posts/{id}/revisions";
    private static final String REVISION = "/api/v1/admin/posts/{id}/revisions/{revisionId}";
    private static final String RESTORE = "/api/v1/admin/posts/{id}/revisions/{revisionId}/restore";
    private static final String TAG_MERGE = "/api/v1/admin/tags/{id}/merge";
    private static final String CATEGORY_MERGE = "/api/v1/admin/categories/{id}/merge";
    private static final String MEDIA_USAGE = "/api/v1/admin/media/usage";
    private static final String MY_APPLICATION = "/api/v1/me/author-application";
    private static final String APPLICATIONS = "/api/v1/admin/author-applications";
    private static final String APPROVE = "/api/v1/admin/author-applications/{id}/approve";
    private static final String REJECT = "/api/v1/admin/author-applications/{id}/reject";
    private static final String BOOKMARKS = "/api/v1/me/bookmarks";
    private static final String BOOKMARK = "/api/v1/me/bookmarks/{slug}";
    private static final String VIEWS = "/api/v1/posts/{slug}/views";
    private static final String ANALYTICS = "/api/v1/admin/analytics";
    private static final String NEWSLETTER_SUBSCRIPTIONS = "/api/v1/newsletter/subscriptions";
    private static final String NEWSLETTER_CONFIRM = "/api/v1/newsletter/confirm";
    private static final String NEWSLETTER_UNSUBSCRIBE = "/api/v1/newsletter/unsubscribe";
    private static final String ADMIN_NEWSLETTER = "/api/v1/admin/newsletter";
    private static final String PROFILE = "/api/v1/users/{slug}";
    private static final String POSTS = "/api/v1/posts";

    private enum Access {
        NONE,
        OPTIONAL,
        REQUIRED
    }

    /** One operation of the document. */
    private record Op(String method, String path, JsonNode operation) {

        String key() {
            return method.toUpperCase(Locale.ROOT) + " " + path;
        }

        Access access() {
            JsonNode security = operation.path("security");
            boolean anonymous = false;
            boolean bearer = false;
            for (JsonNode requirement : security) {
                if (requirement.isEmpty()) {
                    anonymous = true;
                } else if (requirement.has(OpenApiConfig.BEARER)) {
                    bearer = true;
                }
            }
            return !bearer ? Access.NONE : anonymous ? Access.OPTIONAL : Access.REQUIRED;
        }

        boolean multipart() {
            return operation.path("requestBody").path("content").has(MULTIPART_FORM_DATA_VALUE);
        }

        @Override
        public String toString() {
            return key();
        }
    }

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
    @Qualifier("requestMappingHandlerMapping")
    private RequestMappingHandlerMapping handlerMapping;

    @Autowired
    private NewsletterTokens newsletterTokens;

    private JsonNode doc;

    @Test
    void openApiDocumentIsServedWithConfiguredTitle() throws Exception {
        mockMvc.perform(get("/v3/api-docs"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.info.title").value("Personal Blog API"));
    }

    // --- Paths, methods, handlers ----------------------------------------------------------------------

    @Test
    void document_has_all_auth_comment_like_and_admin_endpoints_of_v5_and_no_github_login_paths() throws Exception {
        Map<String, Set<String>> expected = Map.ofEntries(
                entry("/api/v1/auth/login", Set.of("post")),
                entry("/api/v1/auth/refresh", Set.of("post")),
                entry("/api/v1/auth/logout", Set.of("post")),
                // GET only: no path writes to one's own account; the role changes only in ADMIN_USER_ROLE and
                // APPROVE.
                entry(ME, Set.of("get")),
                entry(COMMENTS_OF_POST, Set.of("get", "post")),
                entry(REPLIES, Set.of("post")),
                entry(COMMENT, Set.of("put", "delete")),
                entry(LIKE, Set.of("get", "put", "delete")),
                // No GET for comment likes (the count travels with the comment), no other write path into
                // notifications.
                entry(COMMENT_LIKE, Set.of("put", "delete")),
                entry(NOTIFICATIONS, Set.of("get")),
                entry(UNREAD_COUNT, Set.of("get")),
                entry(NOTIFICATION_READ, Set.of("post")),
                entry(READ_ALL, Set.of("post")),
                entry(NOTIFICATION, Set.of("delete")),
                entry(ADMIN_COMMENTS, Set.of("get")),
                entry(ADMIN_COMMENT_STATUS, Set.of("patch")),
                entry(ADMIN_COMMENT, Set.of("delete")),
                entry(ADMIN_USERS, Set.of("get")),
                entry(ADMIN_USER_STATUS, Set.of("patch")),
                entry(ADMIN_USER_ROLE, Set.of("patch")),
                // The old-slug lookup path, read only.
                entry(REDIRECT, Set.of("get")),
                // Images inside the post body, revisions, tag and category merge, image quota. There is no path to edit
                // or
                // delete a revision, and no PUT for an image in the body.
                entry(POST_IMAGES, Set.of("get", "post")),
                entry(POST_IMAGE, Set.of("delete")),
                entry(REVISIONS, Set.of("get")),
                entry(REVISION, Set.of("get")),
                entry(RESTORE, Set.of("post")),
                entry(TAG_MERGE, Set.of("post")),
                entry(CATEGORY_MERGE, Set.of("post")),
                entry(MEDIA_USAGE, Set.of("get")),
                // Author applications. There is no cancelling or editing an application.
                entry(MY_APPLICATION, Set.of("get", "post")),
                entry(APPLICATIONS, Set.of("get")),
                entry(APPROVE, Set.of("post")),
                entry(REJECT, Set.of("post")),
                // Bookmarks of the caller. There is no path to unsave everything.
                entry(BOOKMARKS, Set.of("get")),
                entry(BOOKMARK, Set.of("get", "put", "delete")),
                // Views have only POST; statistics are read only.
                entry(VIEWS, Set.of("post")),
                entry(ANALYTICS, Set.of("get")),
                // The newsletter has only three public POSTs and one admin GET of figures; no path reads addresses.
                entry(NEWSLETTER_SUBSCRIPTIONS, Set.of("post")),
                entry(NEWSLETTER_CONFIRM, Set.of("post")),
                entry(NEWSLETTER_UNSUBSCRIBE, Set.of("post")),
                entry(ADMIN_NEWSLETTER, Set.of("get")),
                // Held newsletters (an AUTHOR's first publish): list, then one decision each.
                entry(ADMIN_NEWSLETTER + "/held", Set.of("get")),
                entry(ADMIN_NEWSLETTER + "/issues/{postId}/release", Set.of("post")),
                entry(ADMIN_NEWSLETTER + "/issues/{postId}/discard", Set.of("post")),
                // The contact form has one public POST; the ADMIN inbox lists, counts the unread, marks read and
                // deletes. There is
                // no path to edit or answer a message.
                entry("/api/v1/contact/messages", Set.of("post")),
                entry("/api/v1/admin/contact/messages", Set.of("get")),
                entry("/api/v1/admin/contact/unread-count", Set.of("get")),
                entry("/api/v1/admin/contact/messages/{id}/read", Set.of("post")),
                entry("/api/v1/admin/contact/messages/{id}", Set.of("delete")),
                // Reindex is POST only (dry run by default), status is read only.
                entry("/api/v1/admin/search/reindex", Set.of("post")),
                entry("/api/v1/admin/search/status", Set.of("get")),
                // Public profile is read only; there is no public user list.
                entry(PROFILE, Set.of("get")),
                entry("/api/v1/users", Set.of()));
        for (Map.Entry<String, Set<String>> path : expected.entrySet()) {
            assertThat(methodsOf(path.getKey())).as(path.getKey()).containsExactlyInAnyOrderElementsOf(path.getValue());
        }

        // The two oauth2Login paths are filters of the @Order(2) chain, not controllers: the README describes them.
        assertThat(names(doc().path("paths"))).noneMatch(path -> path.startsWith("/api/v1/auth/oauth2"));
        // The description table of OpenApiConfig says nothing about an operation that does not exist.
        Set<String> documented = new HashSet<>();
        operations().forEach(op -> documented.add(op.key()));
        assertThat(documented).containsAll(OpenApiConfig.describedOperations());
    }

    @Test
    void every_operation_in_document_has_a_real_handler() throws Exception {
        List<Op> operations = operations();
        assertThat(operations).hasSizeGreaterThan(50);
        for (Op op : operations) {
            MockHttpServletRequest request =
                    new MockHttpServletRequest(op.method().toUpperCase(Locale.ROOT), concrete(op.path()));
            if (op.multipart()) {
                request.setContentType(MULTIPART_FORM_DATA_VALUE);
            }
            ServletRequestPathUtils.parseAndCache(request);
            HandlerExecutionChain chain = handlerMapping.getHandler(request);
            assertThat(chain).as(op.key()).isNotNull();
            assertThat(chain.getHandler()).as(op.key()).isInstanceOf(HandlerMethod.class);
        }
    }

    // --- Token ---------------------------------------------------------------------------------------

    @Test
    void document_declares_bearer_JWT_token_and_sets_no_global_requirement() throws Exception {
        assertThat(doc().path("openapi").asString()).startsWith("3.1");
        JsonNode scheme = doc().path("components").path("securitySchemes").path(OpenApiConfig.BEARER);
        assertThat(scheme.path("type").asString()).isEqualTo("http");
        assertThat(scheme.path("scheme").asString()).isEqualTo("bearer");
        assertThat(scheme.path("bearerFormat").asString()).isEqualTo("JWT");
        // Each operation declares itself: a global requirement makes Swagger UI send the token even to public read
        // paths, where an
        // expired token is answered 401 by the bearer filter.
        assertThat(doc().path("security").isEmpty()).isTrue();
    }

    @Test
    void operation_declared_as_needing_token_gets_401_from_real_filter_chain_without_token_and_vice_versa()
            throws Exception {
        Set<String> optional = new TreeSet<>();
        for (Op op : operations()) {
            MockHttpServletResponse response = mockMvc.perform(
                            request(HttpMethod.valueOf(op.method().toUpperCase(Locale.ROOT)), concrete(op.path())))
                    .andReturn()
                    .getResponse();
            String body = response.getContentAsString(StandardCharsets.UTF_8);
            switch (op.access()) {
                case REQUIRED -> {
                    assertThat(response.getStatus()).as("%s: %s", op, body).isEqualTo(401);
                    assertThat(objectMapper
                                    .readTree(body)
                                    .path("error")
                                    .path("code")
                                    .asString())
                            .isEqualTo("UNAUTHENTICATED");
                }
                case OPTIONAL -> {
                    optional.add(op.key());
                    assertThat(response.getStatus()).as("%s: %s", op, body).isNotIn(401, 403);
                }
                case NONE ->
                    assertThat(response.getStatus()).as("%s: %s", op, body).isNotIn(401, 403);
            }
            // Whoever declares needing a token also declares the 401 and 403 answers (or 401 when the token is
            // optional).
            if (op.access() == Access.REQUIRED) {
                assertThat(names(op.operation().path("responses"))).as(op.key()).contains("401", "403");
            } else if (op.access() == Access.OPTIONAL) {
                assertThat(names(op.operation().path("responses"))).as(op.key()).contains("401");
            }
        }
        // The token is optional exactly on the two read paths where the token changes the answer: mine and liked.
        assertThat(optional).containsExactly("GET " + COMMENTS_OF_POST, "GET " + LIKE);
    }

    // --- Schema against the real answer ----------------------------------------------------------------

    @Test
    void v5_schema_declares_null_enum_and_required_fields_as_the_frontend_types_them() throws Exception {
        assertThat(nullable("CommentResponse")).containsExactlyInAnyOrder("content", "author", "editedAt");
        assertThat(nullable("CommentAuthorResponse"))
                .containsExactlyInAnyOrder("githubLogin", "avatarUrl", "profileSlug");
        assertThat(nullable("CommentThreadResponse")).isEmpty();
        assertThat(nullable("CommentPage")).containsExactly("nextCursor");
        assertThat(nullable("LikeResponse")).isEmpty();
        assertThat(nullable("NotificationPage")).containsExactlyInAnyOrder("nextCursor", "headCursor");
        assertThat(nullable("NotificationResponse")).containsExactlyInAnyOrder("commentId", "excerpt");
        assertThat(nullable("NotificationActorResponse")).containsExactlyInAnyOrder("githubLogin", "avatarUrl");
        assertThat(nullable("NotificationPostResponse")).isEmpty();
        assertThat(nullable("UnreadCountResponse")).isEmpty();
        assertThat(nullable("CommentAdminResponse"))
                .containsExactlyInAnyOrder("editedAt", "authorGithubLogin", "authorAvatarUrl");
        assertThat(nullable("UserAdminResponse")).containsExactlyInAnyOrder("githubLogin", "avatarUrl", "lastLoginAt");
        assertThat(nullable("CurrentUserResponse")).containsExactlyInAnyOrder("email", "githubLogin", "avatarUrl");
        assertThat(nullable("TokenResponse")).isEmpty();
        assertThat(nullable("PostRedirectResponse")).isEmpty();
        // Images, quota, revisions, the merge result, and the tag or category that the merge result carries.
        assertThat(nullable("MediaResponse")).containsExactlyInAnyOrder("altText", "dominantColor");
        assertThat(nullable("MediaUsageResponse")).isEmpty();
        assertThat(nullable("PostRevisionSummaryResponse")).isEmpty();
        assertThat(nullable("PostRevisionResponse")).containsExactly("excerpt");
        assertThat(nullable("TagMergeResponse")).isEmpty();
        assertThat(nullable("CategoryMergeResponse")).isEmpty();
        assertThat(nullable("TagResponse")).isEmpty();
        assertThat(nullable("CategoryResponse")).containsExactly("description");
        // The public author of a post, author applications.
        assertThat(nullable("PostAuthorResponse")).containsExactlyInAnyOrder("githubLogin", "avatarUrl", "profileSlug");
        // Public profile.
        assertThat(nullable("UserProfileResponse")).containsExactlyInAnyOrder("githubLogin", "avatarUrl");
        assertThat(nullable("AuthorApplicationResponse")).containsExactlyInAnyOrder("motivation", "decidedAt");
        assertThat(nullable("MyAuthorApplicationResponse")).containsExactlyInAnyOrder("application", "reapplyAfter");
        assertThat(nullable("AuthorApplicationAdminResponse")).containsExactlyInAnyOrder("motivation", "decidedAt");
        assertThat(nullable("AuthorApplicantResponse")).containsExactlyInAnyOrder("githubLogin", "avatarUrl");
        assertThat(nullable("BookmarkResponse")).isEmpty();
        // View report; only since can be null (no per-day data yet).
        assertThat(nullable("AnalyticsResponse")).containsExactly("since");
        for (String name : List.of(
                "AnalyticsTotals",
                "AnalyticsDay",
                "AnalyticsTopPost",
                "AnalyticsSource",
                "NewsletterStateResponse",
                "NewsletterStatsResponse",
                "NewsletterSubscriberCounts",
                "NewsletterIssueStats",
                "NewsletterFailureCount")) {
            assertThat(nullable(name)).as(name).isEmpty();
        }

        // Jackson writes every field, null included: every field is always present.
        for (String name : List.of(
                "CommentResponse",
                "CommentAuthorResponse",
                "CommentThreadResponse",
                "CommentPage",
                "LikeResponse",
                "CommentAdminResponse",
                "UserAdminResponse",
                "CurrentUserResponse",
                "TokenResponse",
                "NotificationPage",
                "NotificationResponse",
                "NotificationActorResponse",
                "NotificationPostResponse",
                "UnreadCountResponse",
                "PostRedirectResponse",
                "MediaResponse",
                "MediaUsageResponse",
                "PostRevisionSummaryResponse",
                "PostRevisionResponse",
                "TagMergeResponse",
                "CategoryMergeResponse",
                "TagResponse",
                "CategoryResponse",
                "PostAuthorResponse",
                "AuthorApplicationResponse",
                "MyAuthorApplicationResponse",
                "AuthorApplicationAdminResponse",
                "AuthorApplicantResponse",
                "BookmarkResponse",
                "AnalyticsResponse",
                "AnalyticsTotals",
                "AnalyticsDay",
                "AnalyticsTopPost",
                "AnalyticsSource",
                "NewsletterStateResponse",
                "NewsletterStatsResponse",
                "NewsletterSubscriberCounts",
                "NewsletterIssueStats",
                "NewsletterFailureCount",
                "UserProfileResponse")) {
            JsonNode schema = component(name);
            assertThat(texts(schema.path("required")))
                    .as(name)
                    .containsExactlyInAnyOrderElementsOf(names(schema.path("properties")));
        }

        assertThat(enumOf("CommentResponse", "status")).containsExactly("VISIBLE", "HIDDEN", "DELETED");
        assertThat(enumOf("NotificationResponse", "type"))
                .containsExactly("POST_LIKED", "POST_COMMENTED", "COMMENT_REPLIED", "COMMENT_LIKED");
        assertThat(enumOf("CommentAdminResponse", "postStatus")).containsExactly("DRAFT", "PUBLISHED", "ARCHIVED");
        assertThat(enumOf("CommentAdminResponse", "authorRole")).containsExactly("ADMIN", "AUTHOR", "USER");
        assertThat(enumOf("UserAdminResponse", "status")).containsExactly("ACTIVE", "SUSPENDED");
        assertThat(enumOf("CurrentUserResponse", "role")).containsExactly("ADMIN", "AUTHOR", "USER");
        // Deletion has its own path: PATCH accepts only two values, DELETED is 400 (verified for real in the admin-area
        // test below).
        assertThat(enumOf("CommentStatusRequest", "status")).containsExactly("VISIBLE", "HIDDEN");
        assertThat(enumOf("UserStatusRequest", "status")).containsExactly("ACTIVE", "SUSPENDED");
        assertThat(enumOf("UserRoleRequest", "role")).containsExactly("ADMIN", "AUTHOR", "USER");
        assertThat(enumOf("AuthorApplicationResponse", "status")).containsExactly("PENDING", "APPROVED", "REJECTED");
        assertThat(enumOf("AuthorApplicationAdminResponse", "status"))
                .containsExactly("PENDING", "APPROVED", "REJECTED");
        assertThat(enumOf("AuthorApplicantResponse", "role")).containsExactly("ADMIN", "AUTHOR", "USER");
        assertThat(enumOf("AnalyticsSource", "source"))
                .containsExactly("direct", "search", "social", "github", "internal", "other");
        assertThat(enumOf("AnalyticsTopPost", "status")).containsExactly("DRAFT", "PUBLISHED", "ARCHIVED");
        assertThat(enumOf("NewsletterStateResponse", "status"))
                .containsExactly("PENDING_CONFIRMATION", "CONFIRMED", "UNSUBSCRIBED");
        assertThat(enumOf("NewsletterIssueStats", "status"))
                .containsExactly("PENDING", "EXPANDED", "HELD", "DISCARDED");

        JsonNode error = component("ErrorResponse");
        assertThat(texts(error.path("required"))).containsExactly("error");
        assertThat(texts(error.path("properties")
                        .path("error")
                        .path("properties")
                        .path("code")
                        .path("enum")))
                .containsExactlyInAnyOrderElementsOf(
                        Arrays.stream(ErrorCode.values()).map(Enum::name).toList());
    }

    @Test
    void real_answers_of_comments_likes_and_auth_match_schema_declared_for_that_status() throws Exception {
        CommentFixtures f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
        Post post = f.publishedPost("Post for the API docs");
        Reader an = f.reader("tai-lieu-an");
        Reader binh = f.reader("tai-lieu-binh");
        Reader cuong = f.reader("tai-lieu-cuong");

        // Success: create (201), reply (201), edit (200), delete (204).
        UUID root = id(documented(f.create(an, post, "Root comment for the docs"), "POST", COMMENTS_OF_POST, 201));
        UUID reply = id(documented(f.reply(binh, root, "Reply for the docs"), "POST", REPLIES, 201));
        documented(f.edit(an, root, "Edited root comment for the docs"), "PUT", COMMENT, 200);
        UUID doomed = f.createdId(f.create(binh, post, "Comment to be deleted"));
        documented(f.remove(binh, doomed), "DELETE", COMMENT, 204);
        // A hidden root with a visible reply: an empty slot, content and author null.
        UUID hidden = f.createdId(f.create(cuong, post, "Root to be hidden"));
        f.reply(cuong, hidden, "Reply still shown").andExpect(status().isCreated());
        f.setCommentStatus(hidden, "HIDDEN");

        // A page with a next page (nextCursor is a string), the last page (nextCursor null) has an empty slot; mine
        // both true and false.
        JsonNode first = documented(f.list(post, an.bearer(), "size", "1"), "GET", COMMENTS_OF_POST, 200);
        assertThat(first.path("data").path("nextCursor").isString()).isTrue();
        JsonNode all = documented(f.list(post, null, "size", "20"), "GET", COMMENTS_OF_POST, 200);
        assertThat(all.path("data").path("nextCursor").isNull()).isTrue();
        JsonNode placeholder = CommentFixtures.thread(all.path("data"), hidden).path("comment");
        assertThat(placeholder.path("content").isNull()).isTrue();
        assertThat(placeholder.path("author").isNull()).isTrue();

        // Like: anonymous GET, PUT, DELETE.
        String likePath = "/api/v1/posts/" + post.slug() + "/like";
        documented(mockMvc.perform(get(likePath)), "GET", LIKE, 200);
        documented(mockMvc.perform(put(likePath).header("Authorization", an.bearer())), "PUT", LIKE, 200);
        documented(mockMvc.perform(delete(likePath).header("Authorization", an.bearer())), "DELETE", LIKE, 200);

        // /auth/me: a reader (email null) and a password-only account (githubLogin, avatarUrl null).
        JsonNode reader = documented(mockMvc.perform(get(ME).header("Authorization", an.bearer())), "GET", ME, 200);
        assertThat(reader.path("data").path("email").isNull()).isTrue();
        User author = auth.createAuthor("tai-lieu-author-" + f.suffix + "@blog.local");
        JsonNode passwordOnly =
                documented(mockMvc.perform(get(ME).header("Authorization", auth.bearerFor(author))), "GET", ME, 200);
        assertThat(passwordOnly.path("data").path("githubLogin").isNull()).isTrue();

        // Errors, one per status code, all with the expected status and the shared error body the document declares for
        // that code.
        documented(f.create(null, post, "No token"), "POST", COMMENTS_OF_POST, 401);
        documented(f.create(an, post, "x"), "POST", COMMENTS_OF_POST, 400);
        documented(f.create(an, post, "Edited root comment for the docs"), "POST", COMMENTS_OF_POST, 409);
        documented(f.reply(binh, reply, "Reply to a reply"), "POST", REPLIES, 422);
        documented(f.reply(binh, UUID.randomUUID(), "Reply to nothing"), "POST", REPLIES, 404);
        documented(f.edit(binh, root, "Edit of someone else"), "PUT", COMMENT, 403);
        documented(f.remove(binh, doomed), "DELETE", COMMENT, 404);
        documented(
                mockMvc.perform(put("/api/v1/posts/khong-co-bai-nay/like").header("Authorization", cuong.bearer())),
                "PUT",
                LIKE,
                404);
        documented(f.list(post, null, "after", "khong-phai-con-tro!"), "GET", COMMENTS_OF_POST, 400);
        documented(mockMvc.perform(get("/api/v1/posts/khong-co-bai-nay/comments")), "GET", COMMENTS_OF_POST, 404);
        documented(mockMvc.perform(get(ME)), "GET", ME, 401);
        User suspended = auth.createReader(auth.nextGithubId(), "tai-lieu-khoa-" + f.suffix, UserStatus.SUSPENDED);
        documented(mockMvc.perform(get(ME).header("Authorization", auth.bearerFor(suspended))), "GET", ME, 403);
        Reader dung = f.reader("tai-lieu-dung");
        for (int i = 1; i <= 5; i++) {
            f.create(dung, post, "Comment number " + i + " within one minute").andExpect(status().isCreated());
        }
        documented(f.create(dung, post, "Sixth comment within one minute"), "POST", COMMENTS_OF_POST, 429);

        // Token: login, refresh, an already used refresh token, and a wrong password.
        User account = auth.createAccount("tai-lieu-login-" + f.suffix + "@blog.local", UserRole.AUTHOR);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                passwordEncoder.encode("mat-khau-tai-lieu"),
                account.getId());
        JsonNode tokens = documented(
                mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content(json(Map.of("email", account.getEmail(), "password", "mat-khau-tai-lieu")))),
                "POST",
                "/api/v1/auth/login",
                200);
        String used = tokens.path("data").path("refreshToken").asString();
        documented(
                mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content(json(Map.of("refreshToken", used)))),
                "POST",
                "/api/v1/auth/refresh",
                200);
        documented(
                mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content(json(Map.of("refreshToken", used)))),
                "POST",
                "/api/v1/auth/refresh",
                401);
        documented(
                mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content(json(Map.of("email", account.getEmail(), "password", "sai")))),
                "POST",
                "/api/v1/auth/login",
                401);

        // The second step: an admin's password answers 202 with a challenge, the code answers with the tokens.
        User admin = auth.createAccount("tai-lieu-hai-buoc-" + f.suffix + "@blog.local", UserRole.ADMIN);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                passwordEncoder.encode("mat-khau-tai-lieu-hai-buoc"),
                admin.getId());
        AuthTestSupport.EnrolledAccount mfa = auth.enroll(admin);
        JsonNode challenge = documented(
                mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content(json(Map.of("email", admin.getEmail(), "password", "mat-khau-tai-lieu-hai-buoc")))),
                "POST",
                "/api/v1/auth/login",
                202);
        String challengeValue = challenge.path("data").path("challenge").asString();
        documented(
                mockMvc.perform(post("/api/v1/auth/mfa/verify")
                        .contentType(APPLICATION_JSON)
                        .content(json(Map.of(
                                "challenge",
                                challengeValue,
                                "code",
                                "000000".equals(mfa.code()) ? "111111" : "000000")))),
                "POST",
                "/api/v1/auth/mfa/verify",
                401);
        auth.resetSecondStep(admin.getId());
        documented(
                mockMvc.perform(post("/api/v1/auth/mfa/verify")
                        .contentType(APPLICATION_JSON)
                        .content(json(Map.of("challenge", challengeValue, "code", mfa.code())))),
                "POST",
                "/api/v1/auth/mfa/verify",
                200);
    }

    @Test
    void real_answers_of_likes_comments_and_notifications_match_schema_declared_for_that_status() throws Exception {
        CommentFixtures f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
        Reader author = f.author("tai-lieu-tac-gia");
        Post post = f.publishedPostBy(author.bearer(), "Post for the notification docs");
        Reader an = f.reader("tai-lieu-thong-bao-an");
        Reader binh = f.reader("tai-lieu-thong-bao-binh");
        UUID comment = f.createdId(f.create(an, post, "Comment for the notification docs"));
        // The author (password only) replies: the notification of An has an actor with login and avatar null.
        f.createdId(f.reply(author, comment, "Author reply for the docs"));

        // Like a comment: PUT and DELETE succeed, then like again so one COMMENT_LIKED notification remains.
        String likePath = "/api/v1/comments/" + comment + "/like";
        documented(mockMvc.perform(put(likePath).header("Authorization", binh.bearer())), "PUT", COMMENT_LIKE, 200);
        documented(
                mockMvc.perform(delete(likePath).header("Authorization", binh.bearer())), "DELETE", COMMENT_LIKE, 200);
        f.likeComment(binh, comment, true).andExpect(status().isOk());
        f.likePost(an, post, true).andExpect(status().isOk());

        // List: a page with a next page (both cursors are strings), the last page (both null); POST_LIKED carries
        // commentId and
        // excerpt null.
        JsonNode first = documented(f.notifications(author, "size", "1"), "GET", NOTIFICATIONS, 200);
        assertThat(first.path("data").path("items").get(0).path("type").asString())
                .isEqualTo("POST_LIKED");
        assertThat(first.path("data").path("items").get(0).path("commentId").isNull())
                .isTrue();
        assertThat(first.path("data").path("nextCursor").isString()).isTrue();
        assertThat(first.path("data").path("headCursor").isString()).isTrue();
        JsonNode last = documented(
                f.notifications(
                        author,
                        "size",
                        "1",
                        "after",
                        first.path("data").path("nextCursor").asString()),
                "GET",
                NOTIFICATIONS,
                200);
        assertThat(last.path("data").path("nextCursor").isNull()).isTrue();
        assertThat(last.path("data").path("headCursor").isNull()).isTrue();
        JsonNode anInbox = documented(f.notifications(an, "unread", "true"), "GET", NOTIFICATIONS, 200);
        assertThat(anInbox.path("data").path("items"))
                .anySatisfy(item -> assertThat(
                                item.path("actor").path("githubLogin").isNull())
                        .isTrue());
        documented(mockMvc.perform(get(UNREAD_COUNT).header("Authorization", an.bearer())), "GET", UNREAD_COUNT, 200);
        UUID anNotification = UUID.fromString(
                anInbox.path("data").path("items").get(0).path("id").asString());
        documented(f.markRead(an, anNotification), "POST", NOTIFICATION_READ, 200);
        documented(f.markAllRead(an, anInbox.path("data").path("headCursor").asString()), "POST", READ_ALL, 200);
        documented(f.deleteNotification(an, anNotification), "DELETE", NOTIFICATION, 200);

        // Errors, one per status code, all with the shared error body the document declares for that code.
        documented(f.deleteNotification(an, anNotification), "DELETE", NOTIFICATION, 404);
        documented(f.markRead(binh, UUID.randomUUID()), "POST", NOTIFICATION_READ, 404);
        documented(
                mockMvc.perform(
                        post("/api/v1/notifications/khong-phai-uuid/read").header("Authorization", an.bearer())),
                "POST",
                NOTIFICATION_READ,
                400);
        documented(
                mockMvc.perform(delete("/api/v1/notifications/khong-phai-uuid").header("Authorization", an.bearer())),
                "DELETE",
                NOTIFICATION,
                400);
        documented(f.markAllRead(an, "khong-phai-con-tro!"), "POST", READ_ALL, 400);
        documented(f.notifications(an, "after", "khong-phai-con-tro!"), "GET", NOTIFICATIONS, 400);
        documented(f.notifications(null), "GET", NOTIFICATIONS, 401);
        documented(mockMvc.perform(get(UNREAD_COUNT)), "GET", UNREAD_COUNT, 401);
        documented(f.markRead(null, anNotification), "POST", NOTIFICATION_READ, 401);
        documented(f.markAllRead(null, null), "POST", READ_ALL, 401);
        documented(f.deleteNotification(null, anNotification), "DELETE", NOTIFICATION, 401);
        documented(f.likeComment(null, comment, true), "PUT", COMMENT_LIKE, 401);
        documented(f.likeComment(null, comment, false), "DELETE", COMMENT_LIKE, 401);
        documented(f.likeComment(binh, UUID.randomUUID(), true), "PUT", COMMENT_LIKE, 404);
        documented(f.likeComment(binh, UUID.randomUUID(), false), "DELETE", COMMENT_LIKE, 404);
        documented(
                mockMvc.perform(put("/api/v1/comments/khong-phai-uuid/like").header("Authorization", binh.bearer())),
                "PUT",
                COMMENT_LIKE,
                400);
        documented(
                mockMvc.perform(delete("/api/v1/comments/khong-phai-uuid/like").header("Authorization", binh.bearer())),
                "DELETE",
                COMMENT_LIKE,
                400);
        Reader suspended = f.reader("tai-lieu-thong-bao-khoa");
        auth.setStatus(suspended.id(), UserStatus.SUSPENDED);
        documented(f.notifications(suspended), "GET", NOTIFICATIONS, 403);
        documented(
                mockMvc.perform(get(UNREAD_COUNT).header("Authorization", suspended.bearer())),
                "GET",
                UNREAD_COUNT,
                403);
        documented(f.markRead(suspended, anNotification), "POST", NOTIFICATION_READ, 403);
        documented(f.markAllRead(suspended, null), "POST", READ_ALL, 403);
        documented(f.deleteNotification(suspended, anNotification), "DELETE", NOTIFICATION, 403);
        documented(f.likeComment(suspended, comment, true), "PUT", COMMENT_LIKE, 403);
        documented(f.likeComment(suspended, comment, false), "DELETE", COMMENT_LIKE, 403);
        // The 31st like within one minute by the same person.
        Reader dung = f.reader("tai-lieu-thong-bao-dung");
        for (int i = 0; i < 30; i++) {
            f.likeComment(dung, comment, i % 2 == 0).andExpect(status().isOk());
        }
        documented(f.likeComment(dung, comment, true), "PUT", COMMENT_LIKE, 429);
        documented(f.likeComment(dung, comment, false), "DELETE", COMMENT_LIKE, 429);
    }

    @Test
    void real_answers_of_moderation_area_and_users_match_schema_declared_for_that_status() throws Exception {
        CommentFixtures f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
        Post post = f.publishedPost("Post for the moderation docs");
        Reader an = f.reader("kiem-duyet-an");
        User author = auth.createAuthor("kiem-duyet-author-" + f.suffix + "@blog.local");
        String admin =
                auth.bearerFor(auth.createAccount("kiem-duyet-admin-" + f.suffix + "@blog.local", UserRole.ADMIN));
        // An edited comment (editedAt present), an unedited one (null), one by a password-only account (login, avatar
        // null).
        UUID edited = f.createdId(f.create(an, post, "Comment to be edited " + f.suffix));
        f.edit(an, edited, "Comment that was edited " + f.suffix).andExpect(status().isOk());
        UUID plain = f.createdId(f.create(an, post, "Comment not edited " + f.suffix));
        f.insertComment(post, author.getId(), null, "Comment of the author " + f.suffix, "VISIBLE", Instant.now());

        JsonNode list = documented(
                mockMvc.perform(get(ADMIN_COMMENTS)
                        .header("Authorization", admin)
                        .param("q", f.suffix)
                        .param("size", "100")),
                "GET",
                ADMIN_COMMENTS,
                200);
        assertThat(list.path("data").size()).isEqualTo(3);
        documented(
                mockMvc.perform(patch("/api/v1/admin/comments/" + plain + "/status")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"status\":\"HIDDEN\"}")),
                "PATCH",
                ADMIN_COMMENT_STATUS,
                200);
        documented(
                mockMvc.perform(patch("/api/v1/admin/comments/" + plain + "/status")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"status\":\"DELETED\"}")),
                "PATCH",
                ADMIN_COMMENT_STATUS,
                400);
        documented(
                mockMvc.perform(patch("/api/v1/admin/comments/" + UUID.randomUUID() + "/status")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"status\":\"HIDDEN\"}")),
                "PATCH",
                ADMIN_COMMENT_STATUS,
                404);
        documented(
                mockMvc.perform(delete("/api/v1/admin/comments/" + edited).header("Authorization", admin)),
                "DELETE",
                ADMIN_COMMENT,
                204);
        documented(
                mockMvc.perform(patch("/api/v1/admin/comments/" + edited + "/status")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"status\":\"VISIBLE\"}")),
                "PATCH",
                ADMIN_COMMENT_STATUS,
                409);
        documented(
                mockMvc.perform(
                        delete("/api/v1/admin/comments/" + UUID.randomUUID()).header("Authorization", admin)),
                "DELETE",
                ADMIN_COMMENT,
                404);
        documented(
                mockMvc.perform(
                        get(ADMIN_COMMENTS).header("Authorization", admin).param("status", "NOPE")),
                "GET",
                ADMIN_COMMENTS,
                400);

        // Users: a reader (latest GitHub login present) and an author (login, avatar, last login null).
        JsonNode users = documented(
                mockMvc.perform(get(ADMIN_USERS)
                        .header("Authorization", admin)
                        .param("q", f.suffix)
                        .param("size", "100")),
                "GET",
                ADMIN_USERS,
                200);
        assertThat(users.path("data").size()).isGreaterThanOrEqualTo(2);
        String readerStatus = "/api/v1/admin/users/" + an.id() + "/status";
        documented(
                mockMvc.perform(patch(readerStatus)
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"status\":\"SUSPENDED\"}")),
                "PATCH",
                ADMIN_USER_STATUS,
                200);
        documented(
                mockMvc.perform(patch("/api/v1/admin/users/" + author.getId() + "/status")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"status\":\"SUSPENDED\"}")),
                "PATCH",
                ADMIN_USER_STATUS,
                409);
        documented(
                mockMvc.perform(patch("/api/v1/admin/users/" + UUID.randomUUID() + "/status")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"status\":\"ACTIVE\"}")),
                "PATCH",
                ADMIN_USER_STATUS,
                404);
        documented(
                mockMvc.perform(get(ADMIN_USERS).header("Authorization", admin).param("role", "NOPE")),
                "GET",
                ADMIN_USERS,
                400);
        documented(
                mockMvc.perform(get(ADMIN_USERS).header("Authorization", auth.bearerFor(author))),
                "GET",
                ADMIN_USERS,
                403);
        documented(mockMvc.perform(get(ADMIN_USERS)), "GET", ADMIN_USERS, 401);

        // Role change. 409 LAST_ADMIN needs a DB with only one ADMIN (LastAdminIT), 429 needs 21 changes.
        Reader binh = f.reader("kiem-duyet-binh");
        JsonNode promoted = documented(setRole(admin, binh.id(), "AUTHOR"), "PATCH", ADMIN_USER_ROLE, 200);
        assertThat(promoted.path("data").path("role").asString()).isEqualTo("AUTHOR");
        documented(setRole(admin, binh.id(), "OWNER"), "PATCH", ADMIN_USER_ROLE, 400);
        documented(setRole(admin, UUID.randomUUID(), "USER"), "PATCH", ADMIN_USER_ROLE, 404);
        documented(setRole(auth.bearerFor(author), binh.id(), "ADMIN"), "PATCH", ADMIN_USER_ROLE, 403);
        documented(setRole(null, binh.id(), "ADMIN"), "PATCH", ADMIN_USER_ROLE, 401);
    }

    @Test
    void real_answer_of_old_slug_lookup_matches_schema_declared_for_that_status() throws Exception {
        CommentFixtures f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
        Post post = f.publishedPost("Slug-change post for the docs");
        String admin = auth.bearerForAdmin();
        JsonNode current = objectMapper
                .readTree(
                        mockMvc.perform(get("/api/v1/admin/posts/" + post.id()).header("Authorization", admin))
                                .andExpect(status().isOk())
                                .andReturn()
                                .getResponse()
                                .getContentAsString(StandardCharsets.UTF_8))
                .path("data");
        String moved = post.slug() + "-moi";
        mockMvc.perform(put("/api/v1/admin/posts/" + post.id())
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(json(Map.of(
                                "title", current.path("title").asString(),
                                "content", current.path("content").asString(),
                                "categoryId",
                                        current.path("category").path("id").asString(),
                                "slug", moved))))
                .andExpect(status().isOk());

        // Anonymous, like every post read path.
        JsonNode redirect =
                documented(mockMvc.perform(get("/api/v1/posts/" + post.slug() + "/redirect")), "GET", REDIRECT, 200);
        assertThat(redirect.path("data").path("slug").asString()).isEqualTo(moved);
        // The current slug is not the old slug of any post.
        documented(mockMvc.perform(get("/api/v1/posts/" + moved + "/redirect")), "GET", REDIRECT, 404);
    }

    @Test
    void real_answers_of_body_images_revisions_merge_and_quota_match_declared_schema() throws Exception {
        String admin = auth.bearerForAdmin();
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        String author = auth.bearerFor(auth.createAuthor("tai-lieu-p2-" + suffix + "@blog.local"));
        UUID category = adminCreate(admin, "/api/v1/admin/categories", Map.of("name", "Docs category " + suffix));
        // No excerpt: the first revision has a null excerpt.
        UUID postId = adminCreate(
                admin,
                "/api/v1/admin/posts",
                Map.of(
                        "title", "Post for the docs P2 " + suffix,
                        "content", "First content " + suffix,
                        "categoryId", category.toString()));
        String images = "/api/v1/admin/posts/" + postId + "/images";

        // Image in the body: no description (altText null), with a description, list, delete, then errors.
        JsonNode bare = documented(
                mockMvc.perform(multipart(images).file(png()).header("Authorization", admin)),
                "POST",
                POST_IMAGES,
                200);
        assertThat(bare.path("data").path("altText").isNull()).isTrue();
        documented(
                mockMvc.perform(multipart(images)
                        .file(png())
                        .param("altText", "Description " + suffix)
                        .header("Authorization", admin)),
                "POST",
                POST_IMAGES,
                200);
        documented(mockMvc.perform(get(images).header("Authorization", admin)), "GET", POST_IMAGES, 200);
        documented(
                mockMvc.perform(delete(images + "/" + id(bare)).header("Authorization", admin)),
                "DELETE",
                POST_IMAGE,
                200);
        documented(
                mockMvc.perform(delete(images + "/" + id(bare)).header("Authorization", admin)),
                "DELETE",
                POST_IMAGE,
                404);
        documented(
                mockMvc.perform(multipart("/api/v1/admin/posts/" + UUID.randomUUID() + "/images")
                        .file(png())
                        .header("Authorization", admin)),
                "POST",
                POST_IMAGES,
                404);
        documented(
                mockMvc.perform(multipart(images)
                        .file(new MockMultipartFile("file", "rong.png", "image/png", new byte[0]))
                        .header("Authorization", admin)),
                "POST",
                POST_IMAGES,
                400);
        documented(
                mockMvc.perform(multipart(images).file(png()).header("Authorization", author)),
                "POST",
                POST_IMAGES,
                403);
        documented(
                mockMvc.perform(get("/api/v1/admin/posts/" + UUID.randomUUID() + "/images")
                        .header("Authorization", admin)),
                "GET",
                POST_IMAGES,
                404);

        // Revision: a content change records the previous state.
        mockMvc.perform(put("/api/v1/admin/posts/" + postId)
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(json(Map.of(
                                "title",
                                "Post for the docs P2 " + suffix,
                                "content",
                                "Later content " + suffix,
                                "categoryId",
                                category.toString()))))
                .andExpect(status().isOk());
        String revisions = "/api/v1/admin/posts/" + postId + "/revisions";
        JsonNode history =
                documented(mockMvc.perform(get(revisions).header("Authorization", admin)), "GET", REVISIONS, 200);
        String revisionId = history.path("data").get(0).path("id").asString();
        JsonNode revision = documented(
                mockMvc.perform(get(revisions + "/" + revisionId).header("Authorization", admin)),
                "GET",
                REVISION,
                200);
        assertThat(revision.path("data").path("excerpt").isNull()).isTrue();
        documented(
                mockMvc.perform(get(revisions + "/" + UUID.randomUUID()).header("Authorization", admin)),
                "GET",
                REVISION,
                404);
        documented(
                mockMvc.perform(
                        post(revisions + "/" + UUID.randomUUID() + "/restore").header("Authorization", admin)),
                "POST",
                RESTORE,
                404);
        documented(mockMvc.perform(get(revisions).header("Authorization", author)), "GET", REVISIONS, 403);
        documented(
                mockMvc.perform(post(revisions + "/" + revisionId + "/restore").header("Authorization", author)),
                "POST",
                RESTORE,
                403);

        // Merge tags and categories: success (category description null), merge into itself (400), missing source
        // (404).
        UUID sourceTag = adminCreate(admin, "/api/v1/admin/tags", Map.of("name", "Docs source tag " + suffix));
        UUID targetTag = adminCreate(admin, "/api/v1/admin/tags", Map.of("name", "Docs target tag " + suffix));
        documented(merge(admin, "tags", sourceTag, targetTag), "POST", TAG_MERGE, 200);
        documented(merge(admin, "tags", targetTag, targetTag), "POST", TAG_MERGE, 400);
        documented(merge(admin, "tags", sourceTag, targetTag), "POST", TAG_MERGE, 404);
        documented(merge(author, "tags", targetTag, targetTag), "POST", TAG_MERGE, 403);
        UUID sourceCategory =
                adminCreate(admin, "/api/v1/admin/categories", Map.of("name", "Docs source category " + suffix));
        JsonNode categoryMerge =
                documented(merge(admin, "categories", sourceCategory, category), "POST", CATEGORY_MERGE, 200);
        assertThat(categoryMerge.path("data").path("target").path("description").isNull())
                .isTrue();
        documented(merge(admin, "categories", category, category), "POST", CATEGORY_MERGE, 400);
        documented(merge(admin, "categories", sourceCategory, category), "POST", CATEGORY_MERGE, 404);

        // Image quota, and the moderation list filtered by post.
        documented(mockMvc.perform(get(MEDIA_USAGE).header("Authorization", admin)), "GET", MEDIA_USAGE, 200);
        documented(mockMvc.perform(get(MEDIA_USAGE).header("Authorization", author)), "GET", MEDIA_USAGE, 403);
        documented(
                mockMvc.perform(
                        get(ADMIN_COMMENTS).header("Authorization", admin).param("postId", postId.toString())),
                "GET",
                ADMIN_COMMENTS,
                200);
        documented(
                mockMvc.perform(
                        get(ADMIN_COMMENTS).header("Authorization", admin).param("postId", "khong-phai-uuid")),
                "GET",
                ADMIN_COMMENTS,
                400);
    }

    @Test
    void real_post_author_matches_PostAuthorResponse_schema_that_both_post_DTOs_point_to() throws Exception {
        // The two post DTOs have no field described as null, so only the author part is compared with the real answer.
        for (String dto : List.of("PostResponse", "PostSummaryResponse")) {
            assertThat(component(dto)
                            .path("properties")
                            .path("author")
                            .path("$ref")
                            .asString())
                    .as(dto)
                    .endsWith("/PostAuthorResponse");
        }
        CommentFixtures f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
        // A password-only author: githubLogin and avatarUrl are null, exactly the two fields the document declares
        // nullable.
        Reader writer = f.author("tai-lieu-tac-gia");
        Post post = f.publishedPostBy(writer.bearer(), "Post for the author docs");
        JsonNode author = objectMapper
                .readTree(mockMvc.perform(get("/api/v1/posts/" + post.slug()))
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString(StandardCharsets.UTF_8))
                .path("data")
                .path("author");

        assertThat(author.path("githubLogin").isNull()).isTrue();
        assertConforms(author, component("PostAuthorResponse"), "GET /api/v1/posts/{slug} 200: data.author");
    }

    @Test
    void real_answers_of_public_profile_and_posts_by_author_filter_match_declared_schema() throws Exception {
        CommentFixtures f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
        // A GitHub reader (with login and avatar) and a password-only author (those two fields null, exactly the two
        // declared nullable).
        User reader = auth.createReader(auth.nextGithubId(), "tai-lieu-ho-so-" + f.suffix);
        Reader author = f.author("tai-lieu-ho-so-tac-gia");
        String authorSlug =
                jdbcTemplate.queryForObject("SELECT public_slug FROM users WHERE id = ?", String.class, author.id());
        documented(mockMvc.perform(get("/api/v1/users/" + reader.getPublicSlug())), "GET", PROFILE, 200);
        JsonNode passwordOnly = documented(mockMvc.perform(get("/api/v1/users/" + authorSlug)), "GET", PROFILE, 200);
        assertThat(passwordOnly.path("data").path("githubLogin").isNull()).isTrue();
        documented(mockMvc.perform(get("/api/v1/users/khong-co-ai-" + f.suffix)), "GET", PROFILE, 404);
        documented(mockMvc.perform(get("/api/v1/users/Sai-Dang")), "GET", PROFILE, 404);
        // Post list: PostSummaryResponse declares no field nullable (see the post author test), so only errors are
        // compared.
        documented(mockMvc.perform(get(POSTS).param("author", authorSlug).param("sort", "popular")), "GET", POSTS, 400);
    }

    @Test
    void real_answers_of_author_applications_match_schema_declared_for_that_status() throws Exception {
        CommentFixtures f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
        Reader an = f.reader("tai-lieu-don-an");
        Reader binh = f.reader("tai-lieu-don-binh");
        String admin =
                auth.bearerFor(auth.createAccount("tai-lieu-don-admin-" + f.suffix + "@blog.local", UserRole.ADMIN));

        // Applicant: no application yet (application and reapplyAfter null), an application without a message
        // (motivation, decidedAt null).
        JsonNode none = documented(myApplication(an.bearer()), "GET", MY_APPLICATION, 200);
        assertThat(none.path("data").path("application").isNull()).isTrue();
        UUID anApplication = id(documented(apply(an.bearer(), Map.of()), "POST", MY_APPLICATION, 201));
        UUID binhApplication = id(documented(
                apply(binh.bearer(), Map.of("motivation", "Wants to write about Postgres")),
                "POST",
                MY_APPLICATION,
                201));
        documented(myApplication(an.bearer()), "GET", MY_APPLICATION, 200);

        // Admin: the queue, approve, reject, a decided application; a rejected person sees reapplyAfter.
        documented(mockMvc.perform(get(APPLICATIONS).header("Authorization", admin)), "GET", APPLICATIONS, 200);
        documented(decide(admin, anApplication, "approve"), "POST", APPROVE, 200);
        documented(decide(admin, binhApplication, "reject"), "POST", REJECT, 200);
        documented(
                mockMvc.perform(get(APPLICATIONS).header("Authorization", admin).param("status", "REJECTED")),
                "GET",
                APPLICATIONS,
                200);
        JsonNode cooling = documented(myApplication(binh.bearer()), "GET", MY_APPLICATION, 200);
        assertThat(cooling.path("data").path("reapplyAfter").isString()).isTrue();

        // Errors, one per status code. 429 needs 6 submissions or 21 approvals (AuthorApplicationServiceTest).
        documented(apply(binh.bearer(), Map.of("motivation", "x".repeat(501))), "POST", MY_APPLICATION, 400);
        documented(apply(binh.bearer(), Map.of()), "POST", MY_APPLICATION, 409);
        documented(apply(null, Map.of()), "POST", MY_APPLICATION, 401);
        documented(myApplication(null), "GET", MY_APPLICATION, 401);
        Reader suspended = f.reader("tai-lieu-don-khoa");
        auth.setStatus(suspended.id(), UserStatus.SUSPENDED);
        documented(myApplication(suspended.bearer()), "GET", MY_APPLICATION, 403);
        documented(apply(suspended.bearer(), Map.of()), "POST", MY_APPLICATION, 403);
        documented(
                mockMvc.perform(get(APPLICATIONS).header("Authorization", admin).param("status", "NOPE")),
                "GET",
                APPLICATIONS,
                400);
        documented(mockMvc.perform(get(APPLICATIONS).header("Authorization", binh.bearer())), "GET", APPLICATIONS, 403);
        documented(mockMvc.perform(get(APPLICATIONS)), "GET", APPLICATIONS, 401);
        for (String path : List.of(APPROVE, REJECT)) {
            String decision = path.substring(path.lastIndexOf('/') + 1);
            documented(decide(admin, UUID.randomUUID(), decision), "POST", path, 404);
            documented(
                    mockMvc.perform(
                            post(APPLICATIONS + "/khong-phai-uuid/" + decision).header("Authorization", admin)),
                    "POST",
                    path,
                    400);
            documented(decide(binh.bearer(), anApplication, decision), "POST", path, 403);
            documented(decide(null, anApplication, decision), "POST", path, 401);
        }
        documented(decide(admin, binhApplication, "approve"), "POST", APPROVE, 409);
        documented(decide(admin, anApplication, "reject"), "POST", REJECT, 409);
    }

    @Test
    void real_answers_of_bookmarks_match_schema_declared_for_that_status() throws Exception {
        CommentFixtures f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
        Post post = f.publishedPost("Post for the bookmark docs");
        Reader an = f.reader("tai-lieu-luu-an");
        String saved = "/api/v1/me/bookmarks/" + post.slug();
        String unknown = "/api/v1/me/bookmarks/khong-co-bai-nay-" + f.suffix;
        List<HttpMethod> methods = List.of(HttpMethod.GET, HttpMethod.PUT, HttpMethod.DELETE);

        // Empty list: PostSummaryResponse declares no field nullable (see the post author test), so BookmarkIT compares
        // each saved item with the item of the public list.
        documented(bookmarks(HttpMethod.GET, BOOKMARKS, an), "GET", BOOKMARKS, 200);
        for (HttpMethod method : methods) {
            documented(bookmarks(method, saved, an), method.name(), BOOKMARK, 200);
            documented(bookmarks(method, saved, null), method.name(), BOOKMARK, 401);
            documented(bookmarks(method, unknown, an), method.name(), BOOKMARK, 404);
        }
        documented(
                mockMvc.perform(get(BOOKMARKS).param("size", "nhieu").header("Authorization", an.bearer())),
                "GET",
                BOOKMARKS,
                400);
        documented(bookmarks(HttpMethod.GET, BOOKMARKS, null), "GET", BOOKMARKS, 401);
        Reader suspended = f.reader("tai-lieu-luu-khoa");
        auth.setStatus(suspended.id(), UserStatus.SUSPENDED);
        documented(bookmarks(HttpMethod.GET, BOOKMARKS, suspended), "GET", BOOKMARKS, 403);
        for (HttpMethod method : methods) {
            documented(bookmarks(method, saved, suspended), method.name(), BOOKMARK, 403);
        }
        // The 31st save or unsave within one minute by the same person.
        Reader dung = f.reader("tai-lieu-luu-dung");
        for (int i = 0; i < 30; i++) {
            bookmarks(i % 2 == 0 ? HttpMethod.PUT : HttpMethod.DELETE, saved, dung)
                    .andExpect(status().isOk());
        }
        documented(bookmarks(HttpMethod.PUT, saved, dung), "PUT", BOOKMARK, 429);
        documented(bookmarks(HttpMethod.DELETE, saved, dung), "DELETE", BOOKMARK, 429);
    }

    @Test
    void real_answers_of_views_and_statistics_match_schema_declared_for_that_status() throws Exception {
        CommentFixtures f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
        Post post = f.publishedPost("Post for the statistics docs");
        documented(
                mockMvc.perform(post("/api/v1/posts/" + post.slug() + "/views").header("X-View-Referrer", "t.co")),
                "POST",
                VIEWS,
                204);
        documented(mockMvc.perform(post("/api/v1/posts/khong-co-bai-nay-" + f.suffix + "/views")), "POST", VIEWS, 404);

        // A day only this test writes: the ADMIN report has a much-read post and since is a day.
        jdbcTemplate.update(
                "INSERT INTO post_view_daily (post_id, day, source, views) VALUES (?, DATE '2018-06-01', "
                        + "'search', 3)",
                post.id());
        String admin = auth.bearerForAdmin();
        JsonNode full = documented(analytics(admin, "2018-06-01"), "GET", ANALYTICS, 200);
        assertThat(full.path("data").path("topPosts").size()).isEqualTo(1);
        assertThat(full.path("data").path("since").isString()).isTrue();
        // An author with no posts yet: since null, every number is 0.
        JsonNode empty = documented(analytics(f.author("tai-lieu-thong-ke").bearer(), null), "GET", ANALYTICS, 200);
        assertThat(empty.path("data").path("since").isNull()).isTrue();

        documented(
                mockMvc.perform(get(ANALYTICS)
                        .param("from", "2018-06-02")
                        .param("to", "2018-06-01")
                        .header("Authorization", admin)),
                "GET",
                ANALYTICS,
                400);
        documented(mockMvc.perform(get(ANALYTICS)), "GET", ANALYTICS, 401);
        documented(analytics(f.reader("tai-lieu-thong-ke-doc-gia").bearer(), null), "GET", ANALYTICS, 403);
    }

    @Test
    void real_answers_of_newsletter_match_schema_declared_for_that_status() throws Exception {
        CommentFixtures f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
        String address = "tai-lieu-newsletter-" + f.suffix + "@example.com";
        documented(
                newsletter(NEWSLETTER_SUBSCRIPTIONS, Map.of("email", address)), "POST", NEWSLETTER_SUBSCRIPTIONS, 202);
        documented(
                newsletter(NEWSLETTER_SUBSCRIPTIONS, Map.of("email", "khong-phai-email")),
                "POST",
                NEWSLETTER_SUBSCRIPTIONS,
                400);

        // Confirm: a token still valid (200), reuse (400). An expired token of a different address, 20 times, then 429.
        String token = pendingNewsletterToken("tai-lieu-xn-" + f.suffix + "@example.com", "1 day");
        documented(newsletter(NEWSLETTER_CONFIRM, Map.of("token", token)), "POST", NEWSLETTER_CONFIRM, 200);
        documented(newsletter(NEWSLETTER_CONFIRM, Map.of("token", token)), "POST", NEWSLETTER_CONFIRM, 400);
        String limited = "tai-lieu-han-muc-" + f.suffix + "@example.com";
        String expired = pendingNewsletterToken(limited, "-1 minute");
        for (int i = 0; i < 20; i++) {
            newsletter(NEWSLETTER_CONFIRM, Map.of("token", expired)).andExpect(status().isBadRequest());
        }
        documented(newsletter(NEWSLETTER_CONFIRM, Map.of("token", expired)), "POST", NEWSLETTER_CONFIRM, 429);

        UUID subscriber = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO newsletter_subscribers (id, email, status, confirmed_at) "
                        + "VALUES (?, ?, 'CONFIRMED', now())",
                subscriber,
                "tai-lieu-huy-" + f.suffix + "@example.com");
        documented(
                newsletter(NEWSLETTER_UNSUBSCRIBE, Map.of("token", newsletterTokens.unsubscribeToken(subscriber))),
                "POST",
                NEWSLETTER_UNSUBSCRIBE,
                200);
        documented(
                newsletter(NEWSLETTER_UNSUBSCRIBE, Map.of("token", "khong-phai-token-hop-le")),
                "POST",
                NEWSLETTER_UNSUBSCRIBE,
                400);
        UUID limitedId = jdbcTemplate.queryForObject(
                "SELECT id FROM newsletter_subscribers WHERE email = ?", UUID.class, limited);
        documented(
                newsletter(NEWSLETTER_UNSUBSCRIBE, Map.of("token", newsletterTokens.unsubscribeToken(limitedId))),
                "POST",
                NEWSLETTER_UNSUBSCRIBE,
                429);

        // Figures: the first publish of every test in the suite already recorded an issue, so the list has a row to
        // compare with the schema.
        f.publishedPost("Post for the newsletter docs");
        JsonNode stats = documented(
                mockMvc.perform(get(ADMIN_NEWSLETTER).header("Authorization", auth.bearerForAdmin())),
                "GET",
                ADMIN_NEWSLETTER,
                200);
        assertThat(stats.path("data").path("issues").size()).isBetween(1, 10);
        documented(mockMvc.perform(get(ADMIN_NEWSLETTER)), "GET", ADMIN_NEWSLETTER, 401);
        documented(
                mockMvc.perform(get(ADMIN_NEWSLETTER)
                        .header("Authorization", f.author("tai-lieu-nl").bearer())),
                "GET",
                ADMIN_NEWSLETTER,
                403);
    }

    // --- Reading the document --------------------------------------------------------------------------

    private JsonNode doc() throws Exception {
        if (doc == null) {
            String json = mockMvc.perform(get("/v3/api-docs"))
                    .andExpect(status().isOk())
                    .andReturn()
                    .getResponse()
                    .getContentAsString(StandardCharsets.UTF_8);
            doc = objectMapper.readTree(json);
        }
        return doc;
    }

    /** Every operation of the real API (paths under /api/). */
    private List<Op> operations() throws Exception {
        List<Op> operations = new ArrayList<>();
        JsonNode paths = doc().path("paths");
        for (String path : names(paths)) {
            if (!path.startsWith("/api/")) {
                continue;
            }
            for (String method : List.of("get", "post", "put", "patch", "delete")) {
                if (paths.path(path).has(method)) {
                    operations.add(new Op(method, path, paths.path(path).path(method)));
                }
            }
        }
        return operations;
    }

    private Set<String> methodsOf(String path) throws Exception {
        Set<String> methods = new HashSet<>(names(doc().path("paths").path(path)));
        methods.retainAll(Set.of("get", "post", "put", "patch", "delete"));
        return methods;
    }

    private JsonNode component(String name) throws Exception {
        JsonNode schema = doc().path("components").path("schemas").path(name);
        assertThat(schema.isMissingNode()).as("schema %s", name).isFalse();
        return schema;
    }

    /** The fields of a schema that allow null. */
    private Set<String> nullable(String schemaName) throws Exception {
        Set<String> nullable = new TreeSet<>();
        JsonNode properties = component(schemaName).path("properties");
        for (String name : names(properties)) {
            JsonNode property = properties.path(name);
            boolean viaType = types(property).contains("null");
            boolean viaAnyOf = false;
            for (JsonNode option : property.path("anyOf")) {
                viaAnyOf |= types(option).contains("null");
            }
            if (viaType || viaAnyOf) {
                nullable.add(name);
            }
        }
        return nullable;
    }

    private List<String> enumOf(String schemaName, String property) throws Exception {
        return texts(component(schemaName).path("properties").path(property).path("enum"));
    }

    // --- Comparing the real answer with the document ---------------------------------------------------

    /**
     * The real answer must have exactly the status {@code expectedStatus} the call aims at, that status must be declared by the document for this
     * operation, and its body matches the schema declared for that status; a status with no body (204) must have a truly empty body. The status
     * is checked first: if an error path wrongly succeeds, the error schema in the document would never be compared with any real answer.
     * Returns the body that was read (null when empty).
     */
    private JsonNode documented(ResultActions result, String method, String path, int expectedStatus) throws Exception {
        MockHttpServletResponse response = result.andReturn().getResponse();
        String body = response.getContentAsString(StandardCharsets.UTF_8);
        assertThat(response.getStatus()).as("%s %s: %s", method, path, body).isEqualTo(expectedStatus);
        String where = method + " " + path + " " + response.getStatus();
        JsonNode declared = doc().path("paths")
                .path(path)
                .path(method.toLowerCase(Locale.ROOT))
                .path("responses")
                .path(String.valueOf(response.getStatus()));
        assertThat(declared.isMissingNode())
                .as("the docs do not declare %s; real body: %s", where, body)
                .isFalse();

        JsonNode content = declared.path("content");
        if (content.isEmpty()) {
            assertThat(body).as(where).isEmpty();
            return null;
        }
        assertThat(content.size()).as(where).isEqualTo(1);
        JsonNode schema = content.path(names(content).getFirst()).path("schema");
        JsonNode actual = objectMapper.readTree(body);
        assertConforms(actual, schema, where);
        return actual;
    }

    /**
     * A real JSON value against a schema of the document, the part of JSON Schema this document uses: {@code $ref},
     * {@code anyOf}, {@code type} (a string or an array, including {@code "null"}), {@code enum}, {@code format} uuid and
     * date-time. An object must have exactly the declared set of fields, none extra and none missing.
     */
    private void assertConforms(JsonNode value, JsonNode schema, String at) throws Exception {
        if (schema.has("$ref")) {
            String ref = schema.path("$ref").asString();
            assertConforms(value, component(ref.substring(ref.lastIndexOf('/') + 1)), at);
            return;
        }
        if (schema.has("anyOf")) {
            List<String> mismatches = new ArrayList<>();
            for (JsonNode option : schema.path("anyOf")) {
                try {
                    assertConforms(value, option, at);
                    return;
                } catch (AssertionError mismatch) {
                    mismatches.add(mismatch.getMessage());
                }
            }
            fail("%s: %s matches none of the choices of %s: %s", at, value, schema, mismatches);
        }
        Set<String> types = types(schema);
        if (value.isNull()) {
            assertThat(types)
                    .as("%s is null but the schema does not allow null: %s", at, schema)
                    .contains("null");
            return;
        }
        if (schema.has("enum")) {
            assertThat(texts(schema.path("enum"))).as("%s outside the enum", at).contains(value.asString());
        }
        if (types.contains("object")) {
            assertThat(value.isObject())
                    .as("%s must be an object: %s", at, value)
                    .isTrue();
            JsonNode properties = schema.path("properties");
            assertThat(names(value))
                    .as("%s: real fields compared with the documented fields", at)
                    .containsExactlyInAnyOrderElementsOf(names(properties));
            for (String name : names(properties)) {
                assertConforms(value.path(name), properties.path(name), at + "." + name);
            }
        } else if (types.contains("array")) {
            assertThat(value.isArray()).as("%s must be an array: %s", at, value).isTrue();
            int index = 0;
            for (JsonNode item : value) {
                assertConforms(item, schema.path("items"), at + "[" + index++ + "]");
            }
        } else if (types.contains("string")) {
            assertThat(value.isString())
                    .as("%s must be a string: %s", at, value)
                    .isTrue();
            String format = schema.has("format") ? schema.path("format").asString() : "";
            if (format.equals("uuid")) {
                UUID.fromString(value.asString());
            } else if (format.equals("date-time")) {
                Instant.parse(value.asString());
            }
        } else if (types.contains("integer")) {
            assertThat(value.isIntegralNumber())
                    .as("%s must be an integer: %s", at, value)
                    .isTrue();
        } else if (types.contains("boolean")) {
            assertThat(value.isBoolean())
                    .as("%s must be a boolean: %s", at, value)
                    .isTrue();
        } else {
            fail("%s: do not know how to check schema %s", at, schema);
        }
    }

    // --- Helpers ---------------------------------------------------------------------------------------

    private static Set<String> types(JsonNode schema) {
        JsonNode type = schema.path("type");
        if (type.isString()) {
            return Set.of(type.asString());
        }
        Set<String> types = new HashSet<>();
        for (JsonNode one : type) {
            types.add(one.asString());
        }
        return types;
    }

    private static List<String> names(JsonNode node) {
        List<String> names = new ArrayList<>();
        node.propertyNames().forEach(names::add);
        return names;
    }

    private static List<String> texts(JsonNode array) {
        List<String> texts = new ArrayList<>();
        for (JsonNode item : array) {
            texts.add(item.asString());
        }
        return texts;
    }

    /** A path of the document with its path variables replaced by values that do not exist. */
    private static String concrete(String path) {
        Matcher variable = Pattern.compile("\\{([^}]+)}").matcher(path);
        StringBuilder concrete = new StringBuilder();
        while (variable.find()) {
            String value = switch (variable.group(1)) {
                case "slug" -> "khong-co-bai-nay-" + UUID.randomUUID();
                case "ext" -> "png";
                default -> UUID.randomUUID().toString();
            };
            variable.appendReplacement(concrete, value);
        }
        variable.appendTail(concrete);
        return concrete.toString();
    }

    private UUID id(JsonNode body) {
        return UUID.fromString(body.path("data").path("id").asString());
    }

    private String json(Object body) {
        return objectMapper.writeValueAsString(body);
    }

    /** Create through an admin POST path (201) and return the id. */
    private UUID adminCreate(String admin, String path, Map<String, ?> body) throws Exception {
        String created = mockMvc.perform(post(path)
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(json(body)))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString(StandardCharsets.UTF_8);
        return id(objectMapper.readTree(created));
    }

    /** {@code POST /api/v1/admin/{kind}/{source}/merge} with {@code {"targetId": target}}. */
    private ResultActions merge(String bearer, String kind, UUID source, UUID target) throws Exception {
        return mockMvc.perform(post("/api/v1/admin/" + kind + "/" + source + "/merge")
                .header("Authorization", bearer)
                .contentType(APPLICATION_JSON)
                .content(json(Map.of("targetId", target.toString()))));
    }

    /** A null {@code bearer} means no token is sent. */
    private ResultActions setRole(String bearer, UUID userId, String role) throws Exception {
        // A change that is a step-up carries the acting administrator's own code (audit 111); the other callers' codes
        // are ignored.
        var request = patch("/api/v1/admin/users/" + userId + "/role")
                .contentType(APPLICATION_JSON)
                .content(json(
                        bearer == null
                                ? Map.of("role", role)
                                : Map.of("role", role, "code", auth.freshCodeForBearer(bearer))));
        return mockMvc.perform(bearer == null ? request : request.header("Authorization", bearer));
    }

    /** Like {@link #setRole}: a null {@code bearer} means no token is sent. */
    private ResultActions myApplication(String bearer) throws Exception {
        var request = get(MY_APPLICATION);
        return mockMvc.perform(bearer == null ? request : request.header("Authorization", bearer));
    }

    private ResultActions apply(String bearer, Map<String, ?> body) throws Exception {
        var request = post(MY_APPLICATION).contentType(APPLICATION_JSON).content(json(body));
        return mockMvc.perform(bearer == null ? request : request.header("Authorization", bearer));
    }

    /** A bookmark path; a null {@code reader} means no token is sent. */
    private ResultActions bookmarks(HttpMethod method, String path, Reader reader) throws Exception {
        var call = request(method, path);
        return mockMvc.perform(reader == null ? call : call.header("Authorization", reader.bearer()));
    }

    /** The statistics report of one day ({@code day}), or the default range when {@code day} is null. */
    private ResultActions analytics(String bearer, String day) throws Exception {
        var request = get(ANALYTICS).header("Authorization", bearer);
        return mockMvc.perform(
                day == null ? request : request.param("from", day).param("to", day));
    }

    /** POST JSON to a public newsletter path, without a token. */
    private ResultActions newsletter(String path, Map<String, String> body) throws Exception {
        return mockMvc.perform(post(path).contentType(APPLICATION_JSON).content(json(body)));
    }

    /**
     * A pending subscription with the confirmation token that the mail sent, expiring after {@code expiresIn} (a Postgres interval, negative means already
     * expired); written the way the worker writes it (only the hash). Returns the raw token.
     */
    private String pendingNewsletterToken(String email, String expiresIn) {
        String token = NewsletterTokens.newConfirmationToken();
        jdbcTemplate.update("""
                INSERT INTO newsletter_subscribers (email, status, confirmation_requested_at, confirmation_sent_at,
                    confirmation_token_hash, confirmation_expires_at)
                VALUES (?, 'PENDING', now(), now(), ?, now() + CAST(? AS interval))""", email, NewsletterTokens.sha256Hex(token), expiresIn);
        return token;
    }

    /** {@code decision} is {@code approve} or {@code reject}. */
    private ResultActions decide(String bearer, UUID application, String decision) throws Exception {
        var request = post(APPLICATIONS + "/" + application + "/" + decision);
        if (bearer != null && decision.equals("approve")) {
            // Making a reader an author carries the acting administrator's own code (audit 111).
            request = request.contentType(APPLICATION_JSON)
                    .content(json(Map.of("code", auth.freshCodeForBearer(bearer))));
        }
        return mockMvc.perform(bearer == null ? request : request.header("Authorization", bearer));
    }

    /** A real PNG image (fixture opaque.png) as the {@code file} part. */
    private static MockMultipartFile png() throws Exception {
        try (InputStream in = OpenApiConfigIT.class.getResourceAsStream("/media/opaque.png")) {
            assertThat(in).as("fixture opaque.png").isNotNull();
            return new MockMultipartFile("file", "opaque.png", "image/png", in.readAllBytes());
        }
    }
}
