package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.auth.dto.TokenResponse;
import com.blog.auth.service.PasswordChangeService;
import com.blog.auth.service.RefreshTokenService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.AuthTestSupport.EnrolledAccount;
import com.blog.support.LogCapture;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The password change: the order of the checks, the policy, the end of every other session with the caller's new one, and the
 * challenges that die with the old password. The accounts are throw-away ones, so the seeded admin keeps its state for the
 * other test classes; the 409 while {@code ADMIN_PASSWORD} is set is in AdminPasswordFromEnvironmentIT, whose context sets it.
 */
@AutoConfigureMockMvc
class PasswordChangeIT extends AbstractIntegrationTest {

    private static final String CURRENT = "mat-khau-hien-tai-cua-tai-khoan";
    private static final String NEW = "mat-khau-moi-dai-va-khac-biet-77";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private JwtDecoder jwtDecoder;

    @Autowired
    private AuthTestSupport auth;

    private User account(UserRole role) {
        User user = auth.createAccount("doi-mat-khau-" + UUID.randomUUID() + "@blog.local", role);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?", passwordEncoder.encode(CURRENT), user.getId());
        return user;
    }

    private MockHttpServletResponse change(TokenResponse session, String current, String next, String code)
            throws Exception {
        Map<String, String> body = new LinkedHashMap<>();
        body.put("currentPassword", current);
        body.put("newPassword", next);
        if (code != null) {
            body.put("code", code);
        }
        return mockMvc.perform(post("/api/v1/me/password")
                        .header("Authorization", "Bearer " + session.accessToken())
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(body)))
                .andReturn()
                .getResponse();
    }

    private JsonNode json(MockHttpServletResponse response) throws Exception {
        return objectMapper.readTree(response.getContentAsString(StandardCharsets.UTF_8));
    }

    private void assertRefused(MockHttpServletResponse response, int status, String code) throws Exception {
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(status);
        assertThat(json(response).path("error").path("code").asString()).isEqualTo(code);
    }

    private String hashOf(User user) {
        return jdbcTemplate.queryForObject("SELECT password_hash FROM users WHERE id = ?", String.class, user.getId());
    }

    private long count(String sql, Object... args) {
        return jdbcTemplate.queryForObject(sql, Long.class, args);
    }

    private MockHttpServletResponse refresh(String refreshToken) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("refreshToken", refreshToken))))
                .andReturn()
                .getResponse();
    }

    // --- The checks, in order ---------------------------------------------------------------------------

    @Test
    void a_wrong_current_password_gets_401_and_changes_nothing() throws Exception {
        User user = account(UserRole.AUTHOR);
        TokenResponse session = auth.verifiedSession(user);
        String before = hashOf(user);

        assertRefused(change(session, "mat-khau-sai-hoan-toan", NEW, null), 401, "INVALID_CREDENTIALS");

        assertThat(hashOf(user)).isEqualTo(before);
        assertThat(count("SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL", user.getId()))
                .isEqualTo(1);
    }

    @Test
    void an_enrolled_account_needs_a_valid_code_and_a_wrong_one_counts() throws Exception {
        User admin = account(UserRole.ADMIN);
        EnrolledAccount mfa = auth.enroll(admin);
        TokenResponse session = auth.verifiedSession(admin);
        String before = hashOf(admin);

        assertRefused(change(session, CURRENT, NEW, null), 401, "MFA_CODE_INVALID");
        assertRefused(
                change(session, CURRENT, NEW, "000000".equals(mfa.code()) ? "111111" : "000000"),
                401,
                "MFA_CODE_INVALID");

        assertThat(hashOf(admin)).isEqualTo(before);
        // The missing code is refused before anything is evaluated; the wrong one is counted like at the sign-in.
        assertThat(count("SELECT failed_attempts FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isEqualTo(1);
    }

    @Test
    void a_new_password_that_breaks_the_policy_is_a_400_with_one_stable_message_and_the_hash_stays() throws Exception {
        User user = account(UserRole.AUTHOR);
        TokenResponse session = auth.verifiedSession(user);
        String before = hashOf(user);

        String tooCommon = "newPassword: is too common or too easy to guess";
        Map<String, String> expected = new LinkedHashMap<>();
        expected.put("password1234", tooCommon);
        expected.put("short", "newPassword: must be at least 12 characters long");
        expected.put(CURRENT, "newPassword: must be different from the current password");
        expected.put("aaaaaaaaaaaaaaaa", tooCommon);
        expected.put(user.getEmail() + "x", tooCommon);
        for (Map.Entry<String, String> weak : expected.entrySet()) {
            MockHttpServletResponse response = change(session, CURRENT, weak.getKey(), null);
            assertRefused(response, 400, "VALIDATION_ERROR");
            assertThat(json(response).path("error").path("message").asString()).isEqualTo(weak.getValue());
            // The value never comes back.
            assertThat(response.getContentAsString()).doesNotContain(weak.getKey());
        }

        assertThat(hashOf(user)).isEqualTo(before);
    }

    @Test
    void a_refused_new_password_does_not_burn_the_code_of_this_step() throws Exception {
        User admin = account(UserRole.ADMIN);
        EnrolledAccount mfa = auth.enroll(admin);
        TokenResponse session = auth.verifiedSession(admin);
        String code = mfa.code();

        assertRefused(change(session, CURRENT, "password1234", code), 400, "VALIDATION_ERROR");

        // The same code, a moment later, still opens the change: the policy is checked before the code is spent.
        MockHttpServletResponse changed = change(session, CURRENT, NEW, code);
        assertThat(changed.getStatus()).as(changed.getContentAsString()).isEqualTo(200);
    }

    @Test
    void an_account_without_a_password_has_nothing_to_change() throws Exception {
        User reader = auth.createReader(auth.nextGithubId(), "khong-mat-khau-" + UUID.randomUUID());
        auth.setRole(reader.getId(), UserRole.AUTHOR);
        TokenResponse session = auth.verifiedSession(reader);

        assertRefused(change(session, CURRENT, NEW, null), 400, "VALIDATION_ERROR");
    }

    @Test
    void a_session_that_started_too_long_ago_is_asked_to_sign_in_again_before_anything_else() throws Exception {
        User user = account(UserRole.AUTHOR);
        TokenResponse stale = auth.verifiedSessionStartedAt(user, Instant.now().minusSeconds(11 * 60));
        String before = hashOf(user);

        // Even a wrong password is not looked at first: the recent sign-in is the first check.
        assertRefused(change(stale, "mat-khau-sai", NEW, null), 401, "REAUTHENTICATION_REQUIRED");
        assertRefused(change(stale, CURRENT, NEW, null), 401, "REAUTHENTICATION_REQUIRED");

        assertThat(hashOf(user)).isEqualTo(before);
    }

    // --- The change itself -----------------------------------------------------------------------------------

    @Test
    void success_ends_every_session_and_answers_the_callers_new_one_with_the_same_start() throws Exception {
        User admin = account(UserRole.ADMIN);
        EnrolledAccount mfa = auth.enroll(admin);
        Instant startedAt = Instant.now().minusSeconds(120);
        TokenResponse caller = auth.verifiedSessionStartedAt(admin, startedAt);
        TokenResponse otherBrowser = auth.verifiedSession(admin);

        try (LogCapture logs = LogCapture.of(PasswordChangeService.class)) {
            MockHttpServletResponse response = change(caller, CURRENT, NEW, mfa.code());

            assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
            JsonNode tokens = json(response).path("data");
            assertThat(passwordEncoder.matches(NEW, hashOf(admin))).isTrue();
            assertThat(passwordEncoder.matches(CURRENT, hashOf(admin))).isFalse();

            // Every older access token is rejected at once; the other browser cannot refresh.
            for (TokenResponse old : new TokenResponse[] {caller, otherBrowser}) {
                mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + old.accessToken()))
                        .andExpect(status().isUnauthorized());
                assertRefused(refresh(old.refreshToken()), 401, "REFRESH_TOKEN_EXPIRED");
            }
            // The returned pair works, and its session started when the caller's old one did: a password change never
            // makes a session look freshly signed in.
            mockMvc.perform(get("/api/v1/auth/me")
                            .header(
                                    "Authorization",
                                    "Bearer " + tokens.path("accessToken").asString()))
                    .andExpect(status().isOk());
            Jwt jwt = jwtDecoder.decode(tokens.path("accessToken").asString());
            assertThat(jwt.<Number>getClaim("auth_time").longValue()).isEqualTo(startedAt.getEpochSecond());
            // The new session carries the second factor this request verified.
            assertThat(jdbcTemplate.queryForObject(
                            "SELECT mfa_verified_at IS NOT NULL FROM refresh_tokens WHERE token_hash = ?",
                            Boolean.class,
                            RefreshTokenService.hash(tokens.path("refreshToken").asString())))
                    .isTrue();

            assertThat(logs.messages()).hasSize(1);
            assertThat(logs.messages().getFirst())
                    .startsWith("password changed userId=" + admin.getId() + " sessionsRevoked=");
            logs.assertNeverLogged(CURRENT, NEW, mfa.code(), admin.getEmail());
        }
    }

    @Test
    void the_sixth_change_in_ten_minutes_is_limited() throws Exception {
        User user = account(UserRole.AUTHOR);
        TokenResponse session = auth.verifiedSession(user);

        for (int i = 0; i < 5; i++) {
            assertRefused(change(session, "mat-khau-sai-" + i, NEW, null), 401, "INVALID_CREDENTIALS");
        }

        assertRefused(change(session, CURRENT, NEW, null), 429, "RATE_LIMITED");
    }

    // --- Pending challenges die with the old password ---------------------------------------------------------

    @Test
    void a_sign_in_challenge_created_before_the_change_is_dead_and_one_created_after_works() throws Exception {
        User admin = account(UserRole.ADMIN);
        EnrolledAccount mfa = auth.enroll(admin);
        // Someone who learned the password started a sign-in; the owner changes the password afterwards.
        String stolen = challengeOf(admin.getEmail(), CURRENT);
        TokenResponse session = auth.verifiedSession(admin);
        assertThat(change(session, CURRENT, NEW, mfa.code()).getStatus()).isEqualTo(200);

        auth.resetSecondStep(admin.getId());
        MockHttpServletResponse verify = mockMvc.perform(post("/api/v1/auth/mfa/verify")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("challenge", stolen, "code", mfa.code()))))
                .andReturn()
                .getResponse();
        assertRefused(verify, 401, "MFA_CHALLENGE_INVALID");

        // The new password opens a new challenge, and that one works.
        assertThat(auth.loginWithSecondStep(mockMvc, admin.getEmail(), NEW, mfa).accessToken())
                .isNotBlank();
    }

    @Test
    void an_enroll_challenge_created_before_the_change_cannot_begin_or_confirm() throws Exception {
        User admin = account(UserRole.ADMIN); // no authenticator yet
        String old = challengeOf(admin.getEmail(), CURRENT);
        TokenResponse session = auth.verifiedSession(admin);
        assertThat(change(session, CURRENT, NEW, null).getStatus()).isEqualTo(200);

        for (String path : new String[] {"/api/v1/auth/mfa/enroll/begin", "/api/v1/auth/mfa/enroll/confirm"}) {
            MockHttpServletResponse response = mockMvc.perform(post(path)
                            .contentType(APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(Map.of("challenge", old, "code", "123456"))))
                    .andReturn()
                    .getResponse();
            assertRefused(response, 401, "MFA_CHALLENGE_INVALID");
        }
        // One created after the change begins an enrollment.
        String fresh = challengeOf(admin.getEmail(), NEW);
        MockHttpServletResponse begun = mockMvc.perform(post("/api/v1/auth/mfa/enroll/begin")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("challenge", fresh))))
                .andReturn()
                .getResponse();
        assertThat(begun.getStatus()).as(begun.getContentAsString()).isEqualTo(200);
    }

    private String challengeOf(String email, String password) throws Exception {
        MockHttpServletResponse response = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("email", email, "password", password))))
                .andReturn()
                .getResponse();
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(202);
        return json(response).path("data").path("challenge").asString();
    }
}
