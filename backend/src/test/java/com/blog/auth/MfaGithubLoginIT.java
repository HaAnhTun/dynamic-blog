package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.GithubLoginFlow;
import com.blog.support.GithubStub;
import com.blog.support.HeldTransaction;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * GitHub is a second way to become ADMIN (ADMIN_GITHUB_ID), so it must go through the very same gate as the password: there
 * is no path to a session that skips the second step. And an author who decides "no second factor" a moment before another
 * tab's enrollment confirms must not end up with an unverified live session.
 */
@AutoConfigureMockMvc
class MfaGithubLoginIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private AuthTestSupport auth;

    private GithubLoginFlow flow() {
        GITHUB.reset();
        return new GithubLoginFlow(mockMvc, GITHUB);
    }

    /** A GitHub account that has the given role: the reader row GitHub login creates, then promoted. */
    private User githubAccount(UserRole role, long githubId, String login) {
        User reader = auth.createReader(githubId, login);
        if (role != UserRole.USER) {
            auth.setRole(reader.getId(), role);
        }
        return reader;
    }

    private JsonNode body(MockHttpServletResponse response) throws Exception {
        return objectMapper.readTree(response.getContentAsString(StandardCharsets.UTF_8));
    }

    @Test
    void a_github_admin_without_an_authenticator_gets_an_enroll_challenge_not_tokens() throws Exception {
        long githubId = auth.nextGithubId();
        String login = "quan-tri-" + UUID.randomUUID().toString().substring(0, 8);
        githubAccount(UserRole.ADMIN, githubId, login);

        MockHttpServletResponse callback = flow().login(GithubStub.profile(githubId, login, "GitHub Admin"))
                .getResponse();

        assertThat(callback.getStatus()).as(callback.getContentAsString()).isEqualTo(202);
        assertThat(callback.getContentAsString()).doesNotContain("accessToken").doesNotContain("refreshToken");
        assertThat(body(callback).path("data").path("purpose").asString()).isEqualTo("ENROLL");
        assertThat(callback.getHeader("Cache-Control")).isEqualTo("no-store");
    }

    @Test
    void an_enrolled_author_gets_a_verify_challenge_and_the_code_opens_the_session() throws Exception {
        long githubId = auth.nextGithubId();
        String login = "tac-gia-" + UUID.randomUUID().toString().substring(0, 8);
        User author = githubAccount(UserRole.AUTHOR, githubId, login);
        AuthTestSupport.EnrolledAccount mfa = auth.enroll(author);

        MockHttpServletResponse callback = flow().login(GithubStub.profile(githubId, login, "GitHub Author"))
                .getResponse();

        assertThat(callback.getStatus()).as(callback.getContentAsString()).isEqualTo(202);
        assertThat(body(callback).path("data").path("purpose").asString()).isEqualTo("VERIFY");
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM refresh_tokens WHERE user_id = ?", Long.class, author.getId()))
                .isZero();
        assertThat(auth.completeSecondStep(mockMvc, callback, mfa).accessToken())
                .isNotBlank();
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND mfa_verified_at IS NOT NULL",
                        Long.class,
                        author.getId()))
                .isEqualTo(1);
    }

    @Test
    void an_author_without_an_enrollment_and_a_reader_get_their_tokens_as_before() throws Exception {
        for (UserRole role : new UserRole[] {UserRole.AUTHOR, UserRole.USER}) {
            long githubId = auth.nextGithubId();
            String login = role.name().toLowerCase(java.util.Locale.ROOT) + "-"
                    + UUID.randomUUID().toString().substring(0, 8);
            githubAccount(role, githubId, login);

            MockHttpServletResponse callback = flow().login(GithubStub.profile(githubId, login, "GitHub " + role))
                    .getResponse();

            assertThat(callback.getStatus()).as(callback.getContentAsString()).isEqualTo(200);
            assertThat(body(callback).path("data").path("accessToken").asString())
                    .isNotBlank();
        }
    }

    @Test
    void a_login_that_waits_for_the_account_lock_sees_the_enrollment_that_committed_meanwhile() throws Exception {
        // The author race. An enrollment confirm holds the account row while it activates the authenticator and revokes
        // the
        // sessions; a password login that read "no second factor" a moment earlier must not slip a session in after it.
        User author = auth.createAccount("dua-nhau-" + UUID.randomUUID() + "@blog.local", UserRole.AUTHOR);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                passwordEncoder.encode("mat-khau-tac-gia-dua-nhau"),
                author.getId());
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try (HeldTransaction confirm = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForList(
                        "SELECT id FROM users WHERE id = ? FOR NO KEY UPDATE", UUID.class, author.getId()))) {
            Future<MockHttpServletResponse> login = pool.submit(() -> mockMvc.perform(post("/api/v1/auth/login")
                            .contentType(APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(
                                    Map.of("email", author.getEmail(), "password", "mat-khau-tac-gia-dua-nhau"))))
                    .andReturn()
                    .getResponse());
            // The login has passed the password and is waiting on the account row: it decided nothing yet.
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "FOR NO KEY UPDATE", 1);

            // The confirm activates the authenticator and commits.
            confirm.commitAfter(jdbc -> jdbc.update(
                    "INSERT INTO user_mfa (user_id, status, secret_cipher, key_id, confirmed_at) "
                            + "VALUES (?, 'ACTIVE', '\\x00', 1, now())",
                    author.getId()));

            MockHttpServletResponse response = login.get(30, TimeUnit.SECONDS);
            assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(202);
            assertThat(body(response).path("data").path("purpose").asString()).isEqualTo("VERIFY");
            assertThat(jdbcTemplate.queryForObject(
                            "SELECT count(*) FROM refresh_tokens WHERE user_id = ?", Long.class, author.getId()))
                    .as("never an unverified live session")
                    .isZero();
        } finally {
            pool.shutdownNow();
        }
    }
}
