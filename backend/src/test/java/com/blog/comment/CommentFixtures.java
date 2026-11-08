package com.blog.comment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Shared data and API calls for the comment ITs, and for the ITs that also need real readers, posts and
 * comments (likes, notifications, account suspension): that is why the class and its methods are public.
 *
 * The DB and the rate limiter (in the context memory) are shared by the whole suite and never cleaned: each
 * instance has its own random suffix, each test creates its own fresh reader (5 comments per minute per
 * person), and the post is created by the seeded admin through the real API. Post titles and content avoid
 * every word that PostSearchAndFeaturedIT searches for. Comments that need a specific time or status (keyset
 * pages, free slots, a full set of 30 replies) are written straight with SQL.
 */
public final class CommentFixtures {

    public record Post(UUID id, String slug) {}

    public record Reader(UUID id, String bearer, String login, String displayName) {}

    private final MockMvc mockMvc;
    private final ObjectMapper objectMapper;
    private final JdbcTemplate jdbcTemplate;
    private final AuthTestSupport auth;
    private final String admin;
    public final String suffix;
    private UUID categoryId;

    public CommentFixtures(
            MockMvc mockMvc, ObjectMapper objectMapper, JdbcTemplate jdbcTemplate, AuthTestSupport auth) {
        this.mockMvc = mockMvc;
        this.objectMapper = objectMapper;
        this.jdbcTemplate = jdbcTemplate;
        this.auth = auth;
        this.admin = auth.bearerForAdmin();
        this.suffix = UUID.randomUUID().toString().substring(0, 8);
    }

    // --- People and posts ------------------------------------------------------------------------------

    /** A fresh GitHub reader, ACTIVE, with its own real access token. */
    public Reader reader(String stem) {
        User user = auth.createReader(auth.nextGithubId(), stem + "-" + suffix);
        return new Reader(user.getId(), auth.bearerFor(user), user.getGithubLogin(), user.getDisplayName());
    }

    /**
     * A fresh author (AUTHOR role, password only: no GitHub login, no avatar) with its own real access token
     * and a display name that does not contain the email. It writes its own posts ({@link #publishedPostBy}):
     * its notification inbox only holds what that test causes, unlike the seeded admin inbox, where every
     * like and comment of every IT piles up.
     */
    public Reader author(String stem) {
        User user = auth.createAuthor(stem + "-" + suffix + "@blog.local");
        String displayName = "Author " + stem + " " + suffix;
        jdbcTemplate.update("UPDATE users SET display_name = ? WHERE id = ?", displayName, user.getId());
        return new Reader(user.getId(), auth.bearerFor(user), null, displayName);
    }

    /** A post published through the admin API. */
    public Post publishedPost(String title) throws Exception {
        return publishedPostBy(admin, title);
    }

    /** A post published through the admin API, owned by the token holder (ADMIN or AUTHOR, publishing their own). */
    public Post publishedPostBy(String bearer, String title) throws Exception {
        Post created = draftPostBy(bearer, title);
        mockMvc.perform(post("/api/v1/admin/posts/" + created.id() + "/publish").header("Authorization", bearer))
                .andExpect(status().isOk());
        return created;
    }

    /** A draft through the admin API: readers cannot see it. */
    public Post draftPost(String title) throws Exception {
        return draftPostBy(admin, title);
    }

    private Post draftPostBy(String bearer, String title) throws Exception {
        String payload = json(Map.of(
                "title", title + " " + suffix,
                "excerpt", "Summary " + suffix,
                "content", "Post content to discuss " + suffix,
                "categoryId", category().toString()));
        JsonNode created = data(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", bearer)
                        .contentType(APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isCreated()));
        return new Post(
                UUID.fromString(created.path("id").asString()),
                created.path("slug").asString());
    }

    public void unpublish(Post post) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + post.id() + "/unpublish").header("Authorization", admin))
                .andExpect(status().isOk());
    }

    public void republish(Post post) throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + post.id() + "/publish").header("Authorization", admin))
                .andExpect(status().isOk());
    }

    /** ARCHIVED has no API path to it: SQL only. */
    public void archive(Post post) {
        assertThat(jdbcTemplate.update("UPDATE posts SET status = 'ARCHIVED' WHERE id = ?", post.id()))
                .isEqualTo(1);
    }

    public void deletePost(Post post) throws Exception {
        mockMvc.perform(delete("/api/v1/admin/posts/" + post.id()).header("Authorization", admin))
                .andExpect(status().isNoContent());
    }

    private UUID category() throws Exception {
        if (categoryId == null) {
            JsonNode category = data(mockMvc.perform(post("/api/v1/admin/categories")
                            .header("Authorization", admin)
                            .contentType(APPLICATION_JSON)
                            .content(json(Map.of("name", "Comment category " + suffix))))
                    .andExpect(status().isCreated()));
            categoryId = UUID.fromString(category.path("id").asString());
        }
        return categoryId;
    }

    // --- Comment API -----------------------------------------------------------------------------------

    public ResultActions create(Reader reader, Post post, String content) throws Exception {
        return send(post("/api/v1/posts/" + post.slug() + "/comments"), reader, Map.of("content", content));
    }

    public ResultActions reply(Reader reader, UUID parentId, String content) throws Exception {
        return send(post("/api/v1/comments/" + parentId + "/replies"), reader, Map.of("content", content));
    }

    public ResultActions edit(Reader reader, UUID commentId, String content) throws Exception {
        return send(put("/api/v1/comments/" + commentId), reader, Map.of("content", content));
    }

    public ResultActions remove(Reader reader, UUID commentId) throws Exception {
        return mockMvc.perform(delete("/api/v1/comments/" + commentId).header("Authorization", reader.bearer()));
    }

    /** Creates and returns the id; fails if the status is not 201. */
    public UUID createdId(ResultActions result) throws Exception {
        JsonNode created = data(result.andExpect(status().isCreated()));
        return UUID.fromString(created.path("id").asString());
    }

    public ResultActions send(MockHttpServletRequestBuilder request, Reader reader, Map<String, ?> body)
            throws Exception {
        if (reader != null) {
            request.header("Authorization", reader.bearer());
        }
        return mockMvc.perform(request.contentType(APPLICATION_JSON).content(json(body)));
    }

    /**
     * GET one page of comments.
     *
     * @param bearer null to read as a user who is not logged in
     * @param params name, value pairs of the parameters
     */
    public ResultActions list(Post post, String bearer, String... params) throws Exception {
        MockHttpServletRequestBuilder request = get("/api/v1/posts/" + post.slug() + "/comments");
        if (bearer != null) {
            request.header("Authorization", bearer);
        }
        for (int i = 0; i < params.length; i += 2) {
            request.param(params[i], params[i + 1]);
        }
        return mockMvc.perform(request);
    }

    /** First page, read as a user who is not logged in, size 20. */
    public JsonNode page(Post post) throws Exception {
        return data(list(post, null, "size", "20").andExpect(status().isOk()));
    }

    /** Ids of the root comments of a page, in the returned order. */
    public static List<UUID> rootIds(JsonNode page) {
        List<UUID> ids = new ArrayList<>();
        page.path("threads")
                .forEach(thread -> ids.add(
                        UUID.fromString(thread.path("comment").path("id").asString())));
        return ids;
    }

    /** The thread of a root comment within the page; fails if it is not there. */
    public static JsonNode thread(JsonNode page, UUID rootId) {
        for (JsonNode thread : page.path("threads")) {
            if (rootId.toString().equals(thread.path("comment").path("id").asString())) {
                return thread;
            }
        }
        throw new AssertionError("Thread not found " + rootId + " trong trang");
    }

    public static List<UUID> replyIds(JsonNode thread) {
        List<UUID> ids = new ArrayList<>();
        thread.path("replies")
                .forEach(reply -> ids.add(UUID.fromString(reply.path("id").asString())));
        return ids;
    }

    // --- Like and notification API ----------------------------------------------------------------

    /** Like ({@code true}, PUT) or unlike ({@code false}, DELETE) a comment; a null {@code reader} is anonymous. */
    public ResultActions likeComment(Reader reader, UUID commentId, boolean like) throws Exception {
        String path = "/api/v1/comments/" + commentId + "/like";
        return perform(like ? put(path) : delete(path), reader);
    }

    /** Like ({@code true}, PUT) or unlike ({@code false}, DELETE) a post; a null {@code reader} means anonymous. */
    public ResultActions likePost(Reader reader, Post post, boolean like) throws Exception {
        String path = "/api/v1/posts/" + post.slug() + "/like";
        return perform(like ? put(path) : delete(path), reader);
    }

    /** {@code GET /api/v1/notifications}; {@code params} are name, value pairs of the parameters. */
    public ResultActions notifications(Reader reader, String... params) throws Exception {
        MockHttpServletRequestBuilder request = get("/api/v1/notifications");
        for (int i = 0; i < params.length; i += 2) {
            request.param(params[i], params[i + 1]);
        }
        return perform(request, reader);
    }

    /** First page of notifications, size 50; fails if the status is not 200. */
    public JsonNode inbox(Reader reader) throws Exception {
        return data(notifications(reader, "size", "50").andExpect(status().isOk()));
    }

    /** Unread count; fails if the status is not 200. */
    public long unreadCount(Reader reader) throws Exception {
        return data(perform(get("/api/v1/notifications/unread-count"), reader).andExpect(status().isOk()))
                .path("count")
                .asLong();
    }

    public ResultActions markRead(Reader reader, UUID notificationId) throws Exception {
        return perform(post("/api/v1/notifications/" + notificationId + "/read"), reader);
    }

    /** @param before headCursor of the page already loaded; null means not sent */
    public ResultActions markAllRead(Reader reader, String before) throws Exception {
        MockHttpServletRequestBuilder request = post("/api/v1/notifications/read-all");
        if (before != null) {
            request.param("before", before);
        }
        return perform(request, reader);
    }

    public ResultActions deleteNotification(Reader reader, UUID notificationId) throws Exception {
        return perform(delete("/api/v1/notifications/" + notificationId), reader);
    }

    private ResultActions perform(MockHttpServletRequestBuilder request, Reader reader) throws Exception {
        if (reader != null) {
            request.header("Authorization", reader.bearer());
        }
        return mockMvc.perform(request);
    }

    // --- Moderation API (seeded admin token; moderation is not rate limited) ---------------------------

    /** PATCH the status of a comment: {@code VISIBLE} shows it again, {@code HIDDEN} hides it. */
    public ResultActions moderate(UUID commentId, String status) throws Exception {
        return moderate(admin, commentId, status);
    }

    /** As above, with the given token (to test permissions). */
    public ResultActions moderate(String bearer, UUID commentId, String status) throws Exception {
        MockHttpServletRequestBuilder request = patch("/api/v1/admin/comments/" + commentId + "/status")
                .contentType(APPLICATION_JSON)
                .content(json(Map.of("status", status)));
        if (bearer != null) {
            request.header("Authorization", bearer);
        }
        return mockMvc.perform(request);
    }

    /** An admin deletes (softly) a comment. */
    public ResultActions adminDelete(UUID commentId) throws Exception {
        return mockMvc.perform(delete("/api/v1/admin/comments/" + commentId).header("Authorization", admin));
    }

    /** Moderation list; {@code params} are name, value pairs of the parameters. */
    public ResultActions adminList(String... params) throws Exception {
        MockHttpServletRequestBuilder request = get("/api/v1/admin/comments").header("Authorization", admin);
        for (int i = 0; i < params.length; i += 2) {
            request.param(params[i], params[i + 1]);
        }
        return mockMvc.perform(request);
    }

    // --- SQL -------------------------------------------------------------------------------------------

    /** A comment written straight to the DB, at the given time and status. */
    public UUID insertComment(Post post, UUID userId, UUID parentId, String content, String status, Instant createdAt) {
        return insertComment(UUID.randomUUID(), post, userId, parentId, content, status, createdAt);
    }

    /** As above, with the given id: to order two comments of the same instant by id. */
    public UUID insertComment(
            UUID id, Post post, UUID userId, UUID parentId, String content, String status, Instant createdAt) {
        OffsetDateTime at = OffsetDateTime.ofInstant(createdAt, ZoneOffset.UTC);
        jdbcTemplate.update("""
                INSERT INTO comments (id, post_id, user_id, parent_id, content, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)""", id, post.id(), userId, parentId, content, status, at, at);
        return id;
    }

    public void setCommentStatus(UUID commentId, String status) {
        assertThat(jdbcTemplate.update(
                        "UPDATE comments SET status = ?, updated_at = now() WHERE id = ?", status, commentId))
                .isEqualTo(1);
    }

    public Map<String, Object> row(UUID commentId) {
        return jdbcTemplate.queryForMap(
                "SELECT user_id, parent_id, content, status, edited_at, updated_at FROM comments WHERE id = ?",
                commentId);
    }

    public long countComments(String where, Object... args) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM comments WHERE " + where, Long.class, args);
    }

    /**
     * A notification written straight to the DB, at the given time: keyset pages, unread count capped at 100.
     * Exactly the columns the real insert writes; the CHECK and the unique index of V22 still apply.
     *
     * @param commentId null for POST_LIKED
     */
    public UUID insertNotification(
            UUID recipientId, UUID actorId, String type, Post post, UUID commentId, Instant createdAt) {
        return insertNotification(UUID.randomUUID(), recipientId, actorId, type, post, commentId, createdAt);
    }

    /** As above, with the given id: to order two notifications of the same instant by id. */
    public UUID insertNotification(
            UUID id, UUID recipientId, UUID actorId, String type, Post post, UUID commentId, Instant createdAt) {
        jdbcTemplate.update(
                """
                INSERT INTO notifications (id, recipient_id, actor_id, type, post_id, comment_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)""",
                id,
                recipientId,
                actorId,
                type,
                post.id(),
                commentId,
                OffsetDateTime.ofInstant(createdAt, ZoneOffset.UTC));
        return id;
    }

    public long countNotifications(String where, Object... args) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM notifications WHERE " + where, Long.class, args);
    }

    /** Ids of the notifications of a page, in the returned order. */
    public static List<UUID> notificationIds(JsonNode page) {
        List<UUID> ids = new ArrayList<>();
        page.path("items")
                .forEach(item -> ids.add(UUID.fromString(item.path("id").asString())));
        return ids;
    }

    // --- JSON ------------------------------------------------------------------------------------------

    public String json(Object body) throws Exception {
        return objectMapper.writeValueAsString(body);
    }

    public JsonNode body(ResultActions result) throws Exception {
        return objectMapper.readTree(result.andReturn().getResponse().getContentAsString());
    }

    public JsonNode data(ResultActions result) throws Exception {
        return body(result).path("data");
    }

    /** Checks the status and error codes, and returns the error body so it can be checked further when needed. */
    public JsonNode assertError(ResultActions result, int status, String code) throws Exception {
        return assertError(result.andReturn().getResponse(), status, code);
    }

    /** As above, for an answer received on another thread. */
    public JsonNode assertError(MockHttpServletResponse response, int status, String code) throws Exception {
        String content = response.getContentAsString();
        assertThat(response.getStatus()).as(content).isEqualTo(status);
        JsonNode error = objectMapper.readTree(content).path("error");
        assertThat(error.path("code").asString()).as(content).isEqualTo(code);
        return error;
    }
}
