package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.common.security.ApiAccessDeniedHandler;
import com.blog.post.entity.Post;
import com.blog.post.repository.PostRepository;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.LogCapture;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserRepository;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.ObjectMapper;

@AutoConfigureMockMvc
class AdminAuthorizationIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private PostRepository postRepository;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void adminPostsIsUnreachableWithoutAToken() throws Exception {
        mockMvc.perform(get("/api/v1/admin/posts"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("UNAUTHENTICATED"));
    }

    @Test
    void adminPostsIsReachableWithAnAdminToken() throws Exception {
        // The control for the test above: the route exists and works, so that 401 was
        // about the missing token.
        mockMvc.perform(get("/api/v1/admin/posts").header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk());
    }

    @Test
    void publicReadsStayPublic() throws Exception {
        mockMvc.perform(get("/api/v1/posts")).andExpect(status().isOk());
    }

    @Test
    void anAuthorReachesAdminPostsButNotTheAdminOnlyArea() throws Exception {
        // This test owns the ROLE boundary: what the URL rules in SecurityConfig decide,
        // before any question of who owns which row.
        //
        // It used to assert that an AUTHOR could not delete a post at all, probing with a
        // post the author had just created itself. That rule is gone: DELETE is now
        // "ADMIN, or the post's own author", so the old probe answers 204 and the old
        // assertion was asserting a rule the product does not want — it refused an author
        // their own draft. The ownership matrix lives in PostOwnershipIT, which drives all
        // five operations across an admin and two separate authors; duplicating a slice of
        // it here would mean two places to update and one of them going stale.
        //
        // What is left here is the part the URL rules own, in both directions.
        User author = auth.createAuthor("author-role-boundary@blog.local");
        String authorToken = auth.bearerFor(author);

        mockMvc.perform(get("/api/v1/admin/posts").header("Authorization", authorToken))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", authorToken)
                        .contentType(APPLICATION_JSON)
                        .content("{\"title\":\"Bai cua author\",\"content\":\"noi dung\"}"))
                .andExpect(status().isCreated());

        // /api/v1/admin/users/** is hasRole('ADMIN') by URL rule alone: AdminUserController has no
        // @PreAuthorize and no notion of ownership, so the rule is the only thing that decides who
        // gets in, which makes it the cleanest probe of the role boundary available. A
        // controller now sits behind it, and the pair below is the evidence: the same request the
        // rule refuses an AUTHOR (403, before routing) is answered 200 for an ADMIN.
        mockMvc.perform(get("/api/v1/admin/users").header("Authorization", authorToken))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));

        mockMvc.perform(get("/api/v1/admin/users").header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk());
    }

    @Test
    void aRefusalByTheUrlRulesNamesTheCallerByIdAndNeverByEmailOrToken() throws Exception {
        User reader = auth.createReader(auth.nextGithubId(), "bi-tu-choi-" + UUID.randomUUID());
        String bearer = auth.bearerFor(reader);
        String token = bearer.substring("Bearer ".length());

        try (LogCapture logs = LogCapture.of(ApiAccessDeniedHandler.class)) {
            mockMvc.perform(get("/api/v1/admin/posts").header("Authorization", bearer))
                    .andExpect(status().isForbidden());

            assertThat(logs.messages())
                    .singleElement()
                    .asString()
                    .startsWith("Access denied method=GET path=/api/v1/admin/posts actor=" + reader.getId() + " ")
                    .doesNotContain(token)
                    .doesNotContain(token.substring(0, 20))
                    .doesNotContain("Bearer");
        }
        // Without a token the 401 comes from the entry point, not from here; a signed-in person without the role is the
        // case.
        try (LogCapture logs = LogCapture.of(ApiAccessDeniedHandler.class)) {
            mockMvc.perform(get("/api/v1/admin/posts")).andExpect(status().isUnauthorized());

            assertThat(logs.messages()).isEmpty();
        }
    }

    @Test
    void aCreatedPostIsAttributedToTheAuthenticatedUser() throws Exception {
        User author = auth.createAuthor("author-attribution@blog.local");

        String created = mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", auth.bearerFor(author))
                        .contentType(APPLICATION_JSON)
                        .content("{\"title\":\"Ai la tac gia\",\"content\":\"noi dung\"}"))
                .andExpect(status().isCreated())
                .andReturn()
                .getResponse()
                .getContentAsString();
        UUID postId = UUID.fromString(
                objectMapper.readTree(created).path("data").path("id").asString());

        // Read through the repository, not the response body: PostResponse deliberately
        // carries no authorId, so asserting on `$.data.authorId` would assert on a field
        // that does not exist and pass against anything. The public post payload has no
        // reason to publish a user id, so the DTO is left alone and the test goes to the
        // row instead.
        //
        // Both halves matter. "Not the seeded admin" would have passed before this task
        // only by accident; "is this author" is what cannot pass until the actor comes
        // from the token.
        Post saved = postRepository.findById(postId).orElseThrow();
        assertThat(saved.getAuthor().getId()).isEqualTo(author.getId());
        assertThat(saved.getAuthor().getId()).isNotEqualTo(UUID.fromString("00000000-0000-0000-0000-000000000001"));
    }

    // --- Current role in the DB wins over the claim ---------------------------------------------------------
    //
    // An ADMIN or AUTHOR claim is only an assertion: CurrentAccessJwtConverter reads the role and status in the DB on
    // every request,
    // so a demotion, lock or deletion takes effect immediately; a USER claim does not (CurrentAccessJwtConverterTest).
    // /api/v1/admin/users is an ADMIN-only probe that involves no post ownership.

    @Test
    void admin_or_author_token_loses_access_when_db_demotes_role_but_public_reads_still_work() throws Exception {
        User admin = auth.createAccount("admin-demoted@blog.local", UserRole.ADMIN);
        String mintedWhileAdmin = auth.bearerFor(admin);
        auth.setRole(admin.getId(), UserRole.AUTHOR);

        // Control: the token is still usable for what an AUTHOR may do, so the 403 below is caused by the role.
        mockMvc.perform(get("/api/v1/admin/posts").header("Authorization", mintedWhileAdmin))
                .andExpect(status().isOk());
        mockMvc.perform(get("/api/v1/admin/users").header("Authorization", mintedWhileAdmin))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));

        User author = auth.createAuthor("author-demoted@blog.local");
        String mintedWhileAuthor = auth.bearerFor(author);
        auth.setRole(author.getId(), UserRole.USER);

        mockMvc.perform(get("/api/v1/admin/posts").header("Authorization", mintedWhileAuthor))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));
        // Lost permission, not the session: 403 rather than 401, and a public read carrying that token is still 200.
        mockMvc.perform(get("/api/v1/posts").header("Authorization", mintedWhileAuthor))
                .andExpect(status().isOk());
    }

    @Test
    void author_promoted_to_admin_enters_admin_area_immediately_with_old_token() throws Exception {
        User author = auth.createAuthor("author-promoted@blog.local");
        String mintedWhileAuthor = auth.bearerFor(author);
        mockMvc.perform(get("/api/v1/admin/users").header("Authorization", mintedWhileAuthor))
                .andExpect(status().isForbidden());

        auth.setRole(author.getId(), UserRole.ADMIN);

        mockMvc.perform(get("/api/v1/admin/users").header("Authorization", mintedWhileAuthor))
                .andExpect(status().isOk());
    }

    @Test
    void locked_admin_or_author_account_has_no_access_to_admin_area() throws Exception {
        User admin = auth.createAccount("admin-suspended@blog.local", UserRole.ADMIN);
        User author = auth.createAuthor("author-suspended@blog.local");
        String adminToken = auth.bearerFor(admin);
        String authorToken = auth.bearerFor(author);
        auth.setStatus(admin.getId(), UserStatus.SUSPENDED);
        auth.setStatus(author.getId(), UserStatus.SUSPENDED);

        for (String token : List.of(adminToken, authorToken)) {
            mockMvc.perform(get("/api/v1/admin/posts").header("Authorization", token))
                    .andExpect(status().isForbidden())
                    .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));
        }
        mockMvc.perform(get("/api/v1/admin/users").header("Authorization", adminToken))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));
        mockMvc.perform(get("/api/v1/posts").header("Authorization", authorToken))
                .andExpect(status().isOk());
    }

    @Test
    void admin_token_of_deleted_account_is_rejected_before_any_handler() throws Exception {
        User doomed = auth.createAccount("admin-deleted@blog.local", UserRole.ADMIN);
        String token = auth.bearerFor(doomed);
        userRepository.delete(doomed);

        // The converter does not see the account so it grants no authority: 403 right at the URL rule, before even
        // PostService.create (which
        // would return 404 AUTHOR_NOT_FOUND), for both the CMS and the ADMIN-only area.
        mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", token)
                        .contentType(APPLICATION_JSON)
                        .content("{\"title\":\"Nguoi da bi xoa\",\"content\":\"noi dung\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));
        mockMvc.perform(get("/api/v1/admin/users").header("Authorization", token))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));
    }

    @Test
    void anUnmappedPathIsDenied() throws Exception {
        // denyAll is the fallback rather than authenticated, so an endpoint added without
        // a rule is unreachable instead of quietly open to any logged-in caller.
        //
        // Specifically 403/FORBIDDEN, not just any 4xx: under the old permissive chain this
        // same path answered 404, which is also a 4xx, so is4xxClientError() passed before
        // denyAll existed and proved nothing about the fallback. This test is the only thing
        // guarding the task's central claim, so it must fail if the fallback is ever loosened
        // to authenticated() - under which an unmapped path would 404 (reaching the
        // DispatcherServlet and falling through to Spring's own routing), not 403.
        mockMvc.perform(get("/api/v1/does-not-exist").header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("FORBIDDEN"));

        // Both halves live here, in the file that owns authorization, because both are about
        // WHO is refused rather than what the refusal looks like. Without a token the same
        // path is 401 instead: the fallback stops the request before routing either way, so
        // neither answer is Spring's own 404. A second copy of the ADMIN
        // half was once kept in SecurityErrorEnvelopeIT, which made the "only thing guarding" sentence
        // above false; the copy is gone and the sentence is true again.
        mockMvc.perform(get("/api/v1/does-not-exist"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("UNAUTHENTICATED"));
    }
}
