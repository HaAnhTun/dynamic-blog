package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.blog.auth.dto.TokenResponse;
import com.blog.auth.service.TokenService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.AuthTestSupport.EnrolledAccount;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Re-authentication before a change (ASVS 5.0 7.5.1). Enrolling an authenticator revokes the other sessions, so a short theft
 * of a session would become a durable takeover: every mutation of two-step verification, the password change and the admin's
 * reset of an author first want a session that started with a sign-in within the last 10 minutes, judged by the
 * start of the session, which is read from the session row (rotation copies it and never refreshes it), not from the
 * {@code auth_time} claim of the token.
 */
@AutoConfigureMockMvc
class MfaReauthIT extends AbstractIntegrationTest {

    private static final String PASSWORD = "mat-khau-thu-nghiem-dang-nhap-lai";
    private static final long STALE_SECONDS = 11 * 60;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private TokenService tokenService;

    /** One mutation: how to call it as an enrolled account. */
    private record Mutation(String name, String method, String path, String body) {
        MockHttpServletRequestBuilder request() {
            MockHttpServletRequestBuilder builder = method.equals("DELETE") ? delete(path) : post(path);
            return builder.contentType(APPLICATION_JSON).content(body);
        }
    }

    private static List<Mutation> mutations(String targetAuthor) {
        return List.of(
                new Mutation("enroll/begin", "POST", "/api/v1/me/mfa/enroll/begin", "{}"),
                new Mutation("enroll/confirm", "POST", "/api/v1/me/mfa/enroll/confirm", "{\"code\":\"123456\"}"),
                new Mutation(
                        "recovery-codes/regenerate",
                        "POST",
                        "/api/v1/me/mfa/recovery-codes/regenerate",
                        "{\"code\":\"123456\"}"),
                new Mutation("replace/begin", "POST", "/api/v1/me/mfa/replace/begin", "{\"code\":\"123456\"}"),
                new Mutation("replace/confirm", "POST", "/api/v1/me/mfa/replace/confirm", "{\"code\":\"123456\"}"),
                new Mutation("disable", "DELETE", "/api/v1/me/mfa", "{\"code\":\"123456\"}"),
                new Mutation(
                        "password",
                        "POST",
                        "/api/v1/me/password",
                        "{\"currentPassword\":\"" + PASSWORD
                                + "\",\"newPassword\":\"mat-khau-moi-dai-va-khac-biet-77\"}"),
                new Mutation(
                        "admin reset",
                        "POST",
                        "/api/v1/admin/users/" + targetAuthor + "/mfa/reset",
                        "{\"code\":\"123456\"}"));
    }

    private User account(UserRole role) {
        User user = auth.createAccount("dang-nhap-lai-" + UUID.randomUUID() + "@blog.local", role);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?", passwordEncoder.encode(PASSWORD), user.getId());
        return user;
    }

    private MockHttpServletResponse call(MockHttpServletRequestBuilder request, String accessToken) throws Exception {
        return mockMvc.perform(request.header("Authorization", "Bearer " + accessToken))
                .andReturn()
                .getResponse();
    }

    private JsonNode json(MockHttpServletResponse response) throws Exception {
        return objectMapper.readTree(response.getContentAsString(StandardCharsets.UTF_8));
    }

    private void assertNeedsFreshSignIn(MockHttpServletResponse response, String what) throws Exception {
        assertThat(response.getStatus())
                .as("%s: %s", what, response.getContentAsString())
                .isEqualTo(401);
        assertThat(json(response).path("error").path("code").asString())
                .as(what)
                .isEqualTo("REAUTHENTICATION_REQUIRED");
    }

    private long count(String sql, Object... args) {
        return jdbcTemplate.queryForObject(sql, Long.class, args);
    }

    @Test
    void every_mutation_of_an_old_session_answers_reauthentication_required_and_moves_no_counter() throws Exception {
        for (UserRole role : new UserRole[] {UserRole.AUTHOR, UserRole.ADMIN}) {
            User account = account(role);
            EnrolledAccount mfa = auth.enroll(account);
            User target = account(UserRole.AUTHOR);
            TokenResponse stale =
                    auth.verifiedSessionStartedAt(account, Instant.now().minusSeconds(STALE_SECONDS));
            long refreshTokens = count("SELECT count(*) FROM refresh_tokens WHERE user_id = ?", account.getId());
            String hash = jdbcTemplate.queryForObject(
                    "SELECT password_hash FROM users WHERE id = ?", String.class, account.getId());

            for (Mutation mutation : mutations(target.getId().toString())) {
                if (mutation.name().equals("admin reset") && role != UserRole.ADMIN) {
                    continue;
                }
                assertNeedsFreshSignIn(call(mutation.request(), stale.accessToken()), role + " " + mutation.name());
            }

            // Nothing was looked at or counted: the check precedes the code, the password and the rate limit.
            assertThat(count("SELECT failed_attempts FROM user_mfa WHERE user_id = ?", account.getId()))
                    .isZero();
            assertThat(count("SELECT last_used_step FROM user_mfa WHERE user_id = ?", account.getId()))
                    .isZero();
            assertThat(count("SELECT count(*) FROM refresh_tokens WHERE user_id = ?", account.getId()))
                    .isEqualTo(refreshTokens);
            assertThat(jdbcTemplate.queryForObject(
                            "SELECT password_hash FROM users WHERE id = ?", String.class, account.getId()))
                    .isEqualTo(hash);
            assertThat(mfa.code()).isNotBlank();
        }
    }

    @Test
    void the_auth_time_claim_of_the_token_is_not_trusted_the_session_row_decides() throws Exception {
        User author = account(UserRole.AUTHOR);
        auth.enroll(author);
        TokenResponse stale =
                auth.verifiedSessionStartedAt(author, Instant.now().minusSeconds(STALE_SECONDS));
        // The real session of the author, a start time of eleven minutes ago in its row, and a token of that very
        // session
        // that CLAIMS a sign-in a second ago (audit 112): what somebody who can sign a token would write.
        String claimsFresh = tokenService.mint(author, Instant.now(), auth.sessionIdOf(stale), Instant.now());

        for (Mutation mutation : mutations(UUID.randomUUID().toString())) {
            if (mutation.name().equals("admin reset")) {
                continue;
            }
            assertNeedsFreshSignIn(call(mutation.request(), claimsFresh), mutation.name());
        }
    }

    @Test
    void a_session_refreshed_from_a_token_issued_eleven_minutes_earlier_cannot_enrol_and_rotation_never_refreshes_it()
            throws Exception {
        User author = account(UserRole.AUTHOR);
        TokenResponse stale =
                auth.verifiedSessionStartedAt(author, Instant.now().minusSeconds(STALE_SECONDS));

        MockHttpServletResponse refreshed = mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("refreshToken", stale.refreshToken()))))
                .andReturn()
                .getResponse();
        assertThat(refreshed.getStatus()).as(refreshed.getContentAsString()).isEqualTo(200);
        String refreshedToken = json(refreshed).path("data").path("accessToken").asString();

        // A fresh access token, an old sign-in: the session is still the old one.
        assertNeedsFreshSignIn(
                call(
                        new Mutation("enroll/begin", "POST", "/api/v1/me/mfa/enroll/begin", "{}").request(),
                        refreshedToken),
                "refreshed session");
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ?", author.getId()))
                .isZero();
    }

    @Test
    void a_fresh_sign_in_can_enrol_and_an_account_without_a_password_needs_nothing_else() throws Exception {
        // An author signs in with GitHub: no email, no password. (The public slug is chosen at the first login.)
        User author = auth.createReader(auth.nextGithubId(), "tac-gia-moi-" + UUID.randomUUID());
        auth.setRole(author.getId(), UserRole.AUTHOR);
        TokenResponse fresh = auth.verifiedSession(author);

        MockHttpServletResponse begun = call(
                new Mutation("enroll/begin", "POST", "/api/v1/me/mfa/enroll/begin", "{}").request(),
                fresh.accessToken());

        assertThat(begun.getStatus()).as(begun.getContentAsString()).isEqualTo(200);
        assertThat(json(begun).path("data").path("secretBase32").asString()).matches("[A-Z2-7]{32}");
        assertThat(json(begun).path("data").path("account").asString())
                .as("an account without an email is labelled by its public slug")
                .isEqualTo(jdbcTemplate.queryForObject(
                        "SELECT public_slug FROM users WHERE id = ?", String.class, author.getId()));
    }
}
