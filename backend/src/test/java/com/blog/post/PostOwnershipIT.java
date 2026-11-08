package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.common.exception.GlobalExceptionHandler;
import com.blog.common.security.SeedAdmin;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.LogCapture;
import com.blog.user.entity.User;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The authorization rule for an existing post: ADMIN manages every post, AUTHOR manages only
 * its own.
 *
 * This file exists because the opposite was measured and shipped. The Sprint 4a review drove
 * a real server and found that an AUTHOR token could retitle the ADMIN's post to
 * "HIJACKED by author" and could push an ADMIN draft public — behaviour that matched the
 * authorization plan of the time exactly, which is why no test caught it. The two tests named
 * {@code anAuthorCannotRetitle...} and {@code anAuthorCannotPublish...} below are that exact
 * scenario, and they are the two that must never be weakened.
 *
 * Every case drives the real filter chain with a real signed token. A test that put an
 * Authentication into the SecurityContextHolder would pass even if {@code @PreAuthorize} were
 * deleted outright, because the expression is evaluated by the proxy around the controller
 * method and the context is all it reads.
 */
@AutoConfigureMockMvc
class PostOwnershipIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private String admin;
    private String alice;
    private String bob;
    private User aliceUser;
    private User bobUser;
    private UUID adminPost;
    private UUID alicePost;
    private UUID bobPost;
    private UUID category;

    @BeforeEach
    void seedThreeAuthorsAndTheirPosts() throws Exception {
        admin = auth.bearerForAdmin();
        // Unique emails: AbstractIntegrationTest shares one container for the JVM, so a fixed
        // address collides with whatever an earlier class in the same run created.
        aliceUser = auth.createAuthor("alice-" + UUID.randomUUID() + "@blog.local");
        bobUser = auth.createAuthor("bob-" + UUID.randomUUID() + "@blog.local");
        alice = auth.bearerFor(aliceUser);
        bob = auth.bearerFor(bobUser);

        category = createCategory();
        adminPost = createPost(admin, "Admin post");
        alicePost = createPost(alice, "Alice post");
        bobPost = createPost(bob, "Bob post");
    }

    // ---------------------------------------------------------------- the measured hijack

    @Test
    void anAuthorCannotRetitleSomeoneElsesPost() throws Exception {
        // The exact request the 4a review used to rename the admin's post to
        // "HIJACKED by author". It answered 200 then.
        mockMvc.perform(put("/api/v1/admin/posts/" + adminPost)
                        .header("Authorization", alice)
                        .contentType(APPLICATION_JSON)
                        .content(body("HIJACKED by author")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));

        // Asserting the status alone would pass against a 403 produced for any reason at all,
        // including a bug that refuses every PUT. Read the row back as the admin and prove the
        // title did not move.
        mockMvc.perform(get("/api/v1/admin/posts/" + adminPost).header("Authorization", admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.title").value("Admin post"));
    }

    @Test
    void aRefusedEditOrDeleteOfAnotherAuthorsPostNamesTheCallerByIdAndNeverByEmailOrToken() throws Exception {
        String token = alice.substring("Bearer ".length());

        try (LogCapture logs = LogCapture.of(GlobalExceptionHandler.class)) {
            mockMvc.perform(put("/api/v1/admin/posts/" + adminPost)
                            .header("Authorization", alice)
                            .contentType(APPLICATION_JSON)
                            .content(body("HIJACKED by author")))
                    .andExpect(status().isForbidden());
            mockMvc.perform(delete("/api/v1/admin/posts/" + adminPost).header("Authorization", alice))
                    .andExpect(status().isForbidden());

            assertThat(logs.messages())
                    .hasSize(2)
                    .satisfiesExactly(
                            first -> assertThat(first)
                                    .startsWith("Access denied method=PUT path=/api/v1/admin/posts/" + adminPost
                                            + " actor=" + aliceUser.getId() + " "),
                            second -> assertThat(second)
                                    .startsWith("Access denied method=DELETE path=/api/v1/admin/posts/" + adminPost
                                            + " actor=" + aliceUser.getId() + " "));
            logs.assertNeverLogged(token, token.substring(0, 20), aliceUser.getEmail(), "HIJACKED by author");
        }
    }

    @Test
    void anAuthorCannotPublishSomeoneElsesDraft() throws Exception {
        // The second half of the measured gap: an author pushing another person's unpublished
        // work onto the public site.
        mockMvc.perform(post("/api/v1/admin/posts/" + adminPost + "/publish").header("Authorization", alice))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));

        // The channel that actually matters is the public API, not the admin one: the damage
        // of a wrongful publish is that a reader can see it.
        String slug = slugOf(adminPost);
        mockMvc.perform(get("/api/v1/posts/" + slug)).andExpect(status().isNotFound());
    }

    @Test
    void anAuthorCannotUnpublishSomeoneElsesPost() throws Exception {
        mockMvc.perform(post("/api/v1/admin/posts/" + adminPost + "/publish").header("Authorization", admin))
                .andExpect(status().isOk());
        String slug = slugOf(adminPost);
        // Visible first, or its continued visibility below proves nothing.
        mockMvc.perform(get("/api/v1/posts/" + slug)).andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/admin/posts/" + adminPost + "/unpublish").header("Authorization", alice))
                .andExpect(status().isForbidden());

        mockMvc.perform(get("/api/v1/posts/" + slug)).andExpect(status().isOk());
    }

    @Test
    void anAuthorCannotDeleteSomeoneElsesPost() throws Exception {
        mockMvc.perform(delete("/api/v1/admin/posts/" + adminPost).header("Authorization", alice))
                .andExpect(status().isForbidden());

        mockMvc.perform(get("/api/v1/admin/posts/" + adminPost).header("Authorization", admin))
                .andExpect(status().isOk());
    }

    @Test
    void anAuthorCannotEvenReadSomeoneElsesPost() throws Exception {
        // getById returns the full body whatever the status, so leaving it open would let one
        // author read another's unpublished draft — and would hand the editor a post it could
        // load but never save.
        String denied = mockMvc.perform(get("/api/v1/admin/posts/" + bobPost).header("Authorization", alice))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"))
                .andExpect(jsonPath("$.data").doesNotExist())
                .andReturn()
                .getResponse()
                .getContentAsString(StandardCharsets.UTF_8);
        assertThat(denied).doesNotContain("Bob post").doesNotContain(bobPost.toString());
    }

    @Test
    void anAuthorCannotTouchAnotherAuthorsPostEither() throws Exception {
        // Not only the admin's. Two AUTHOR accounts must be isolated from each other, which is
        // the case a rule written as "only the admin's posts are protected" would miss.
        mockMvc.perform(put("/api/v1/admin/posts/" + bobPost)
                        .header("Authorization", alice)
                        .contentType(APPLICATION_JSON)
                        .content(body("Alice edits Bob post")))
                .andExpect(status().isForbidden());
        mockMvc.perform(delete("/api/v1/admin/posts/" + bobPost).header("Authorization", alice))
                .andExpect(status().isForbidden());
    }

    // ---------------------------------------------------------------- what an author CAN do

    @Test
    void anAuthorManagesItsOwnPostEndToEnd() throws Exception {
        // The positive control for every refusal above. Without it, a rule that refused
        // absolutely everything would satisfy the whole negative half of this file.
        mockMvc.perform(get("/api/v1/admin/posts/" + alicePost).header("Authorization", alice))
                .andExpect(status().isOk());

        mockMvc.perform(put("/api/v1/admin/posts/" + alicePost)
                        .header("Authorization", alice)
                        .contentType(APPLICATION_JSON)
                        .content(body("Alice edits own post")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.title").value("Alice edits own post"));

        mockMvc.perform(post("/api/v1/admin/posts/" + alicePost + "/publish").header("Authorization", alice))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("PUBLISHED"));

        mockMvc.perform(post("/api/v1/admin/posts/" + alicePost + "/unpublish").header("Authorization", alice))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("DRAFT"));
    }

    @Test
    void anAuthorMayDeleteItsOwnPost() throws Exception {
        // A deliberate change of behaviour, not an accident. DELETE was ADMIN-only, which
        // refused an author its own draft. The rule is now "manage what you own", and delete
        // is part of managing.
        mockMvc.perform(delete("/api/v1/admin/posts/" + alicePost).header("Authorization", alice))
                .andExpect(status().isNoContent());

        // An author's delete hides the post and removes nothing (PostDeleteIT): the administrator still finds it,
        // archived,
        // and the author no longer owns it.
        mockMvc.perform(get("/api/v1/admin/posts/" + alicePost).header("Authorization", admin))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("ARCHIVED"));
        mockMvc.perform(get("/api/v1/admin/posts/" + alicePost).header("Authorization", alice))
                .andExpect(status().isForbidden());
    }

    // ---------------------------------------------------------------- what an admin can do

    @Test
    void anAdminManagesAnotherPersonsPost() throws Exception {
        mockMvc.perform(get("/api/v1/admin/posts/" + alicePost).header("Authorization", admin))
                .andExpect(status().isOk());

        mockMvc.perform(put("/api/v1/admin/posts/" + alicePost)
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(body("Admin edits Alice post")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.title").value("Admin edits Alice post"));

        mockMvc.perform(post("/api/v1/admin/posts/" + alicePost + "/publish").header("Authorization", admin))
                .andExpect(status().isOk());

        mockMvc.perform(delete("/api/v1/admin/posts/" + bobPost).header("Authorization", admin))
                .andExpect(status().isNoContent());
    }

    // ---------------------------------------------------------------- forged fields

    @Test
    void forged_fields_in_POST_and_PUT_body_do_not_change_author_featured_or_status() throws Exception {
        // The body claims to be someone else (Bob, then the site owner) and promotes the post; the DTO has no such
        // field.
        String created = mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", alice)
                        .contentType(APPLICATION_JSON)
                        .content(forged("Alice claims to be Bob")))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.data.author.displayName").value(aliceUser.getDisplayName()))
                .andExpect(jsonPath("$.data.author.siteOwner").value(false))
                .andReturn()
                .getResponse()
                .getContentAsString(StandardCharsets.UTF_8);
        UUID forgedPost = UUID.fromString(
                objectMapper.readTree(created).path("data").path("id").asString());
        assertStoredAs(forgedPost, aliceUser.getId());
        assertThat(row(forgedPost).get("published_at")).isNull();

        mockMvc.perform(put("/api/v1/admin/posts/" + alicePost)
                        .header("Authorization", alice)
                        .contentType(APPLICATION_JSON)
                        .content(forged("Alice edits a post claiming to be Bob")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.author.displayName").value(aliceUser.getDisplayName()));
        assertStoredAs(alicePost, aliceUser.getId());

        // An ADMIN editing someone else's post does not become the author either, and PUT is not the way to pick a
        // "Featured post".
        mockMvc.perform(put("/api/v1/admin/posts/" + alicePost)
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(forged("Admin edits Alice post")))
                .andExpect(status().isOk());
        assertStoredAs(alicePost, aliceUser.getId());
    }

    // ---------------------------------------------------------------- the listing

    @Test
    void theAdminListingIsScopedToWhatTheCallerOwns() throws Exception {
        List<String> aliceSees = titlesIn(alice);
        List<String> adminSees = titlesIn(admin);

        assertThat(aliceSees).containsExactly("Alice post");
        // Both halves matter. "Alice sees her own" would pass on a listing that showed
        // everything; "Alice does not see Bob's" would pass on an empty listing.
        assertThat(aliceSees).doesNotContain("Admin post", "Bob post");
        assertThat(adminSees).contains("Admin post", "Alice post", "Bob post");
    }

    @Test
    void theScopedListingReportsItsOwnTotalRatherThanEveryones() throws Exception {
        // Filtering a page after the query would leave the pagination metadata describing the
        // unfiltered set: Alice would be told there were three posts and shown one.
        String body = mockMvc.perform(get("/api/v1/admin/posts?page=0&size=20").header("Authorization", alice))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        JsonNode pagination = objectMapper.readTree(body).path("pagination");

        assertThat(pagination.path("totalElements").asInt()).isEqualTo(1);
        assertThat(pagination.path("totalPages").asInt()).isEqualTo(1);
    }

    // ---------------------------------------------------------------- enumeration

    @Test
    void aPostThatDoesNotExistIsRefusedForAnAuthorAndNotFoundForAnAdmin() throws Exception {
        UUID ghost = UUID.randomUUID();

        // 403 rather than 404 is the point: the ownership check runs before the service loads
        // anything, so an author cannot learn which ids exist by reading status codes.
        mockMvc.perform(get("/api/v1/admin/posts/" + ghost).header("Authorization", alice))
                .andExpect(status().isForbidden());
        mockMvc.perform(delete("/api/v1/admin/posts/" + ghost).header("Authorization", alice))
                .andExpect(status().isForbidden());

        // And the admin, who passes the check, gets the honest answer.
        mockMvc.perform(get("/api/v1/admin/posts/" + ghost).header("Authorization", admin))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("POST_NOT_FOUND"));
    }

    @Test
    void anOwnershipDenialIsIndistinguishableFromARoleDenial() throws Exception {
        // Both must reach the client as the same envelope. If an ownership refusal carried a
        // different code or message, the body would tell a caller whether the post exists and
        // belongs to someone else — which is the enumeration channel the test above closes.
        JsonNode ownership = errorOf(put("/api/v1/admin/posts/" + adminPost)
                .header("Authorization", alice)
                .contentType(APPLICATION_JSON)
                .content(body("x")));
        JsonNode role = errorOf(get("/api/v1/admin/users").header("Authorization", alice));

        assertThat(ownership.path("code").asString()).isEqualTo("FORBIDDEN");
        assertThat(ownership.path("code").asString())
                .isEqualTo(role.path("code").asString());
        assertThat(ownership.path("message").asString())
                .isEqualTo(role.path("message").asString());
        // Different requests, so different traceIds — otherwise the ids identify the shape of
        // the response rather than the request, and a support ticket cannot be traced.
        assertThat(ownership.path("traceId").asString())
                .isNotEqualTo(role.path("traceId").asString());
    }

    // ---------------------------------------------------------------- helpers

    private JsonNode errorOf(org.springframework.test.web.servlet.RequestBuilder request) throws Exception {
        String body = mockMvc.perform(request)
                .andExpect(status().isForbidden())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return objectMapper.readTree(body).path("error");
    }

    private List<String> titlesIn(String token) throws Exception {
        String body = mockMvc.perform(get("/api/v1/admin/posts?page=0&size=50").header("Authorization", token))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        List<String> titles = new ArrayList<>();
        objectMapper
                .readTree(body)
                .path("data")
                .forEach(node -> titles.add(node.path("title").asString()));
        return titles;
    }

    private String slugOf(UUID postId) throws Exception {
        String body = mockMvc.perform(get("/api/v1/admin/posts/" + postId).header("Authorization", admin))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return objectMapper.readTree(body).path("data").path("slug").asString();
    }

    private String body(String title) {
        return "{\"title\":\"" + title + "\",\"content\":\"noi dung\",\"categoryId\":\"" + category + "\"}";
    }

    /** A valid body carrying every way a client could try to change post ownership, the site-owner flag, featured and status. */
    private String forged(String title) {
        return objectMapper.writeValueAsString(Map.of(
                "title",
                title,
                "content",
                "noi dung",
                "categoryId",
                category.toString(),
                "authorId",
                bobUser.getId().toString(),
                "author",
                Map.of("id", SeedAdmin.ID.toString(), "displayName", "Blog owner", "siteOwner", true),
                "featured",
                true,
                "status",
                "PUBLISHED",
                "siteOwner",
                true));
    }

    private Map<String, Object> row(UUID postId) {
        return jdbcTemplate.queryForMap(
                "SELECT author_id, featured, status, published_at FROM posts WHERE id = ?", postId);
    }

    /** The DB row: the right author, not featured, still a draft. */
    private void assertStoredAs(UUID postId, UUID authorId) {
        Map<String, Object> row = row(postId);
        assertThat(row.get("author_id")).isEqualTo(authorId);
        assertThat(row.get("featured")).isEqualTo(false);
        assertThat(row.get("status")).isEqualTo("DRAFT");
    }

    private UUID createCategory() throws Exception {
        String body = mockMvc.perform(post("/api/v1/admin/categories")
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{\"name\":\"Category " + UUID.randomUUID() + "\"}"))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return UUID.fromString(
                objectMapper.readTree(body).path("data").path("id").asString());
    }

    private UUID createPost(String token, String title) throws Exception {
        String body = mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", token)
                        .contentType(APPLICATION_JSON)
                        .content(body(title)))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        return UUID.fromString(
                objectMapper.readTree(body).path("data").path("id").asString());
    }
}
