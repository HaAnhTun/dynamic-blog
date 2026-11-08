package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.auth.dto.TokenResponse;
import com.blog.auth.service.RefreshTokenService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.LogCapture;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The policy of the session at refresh: a session that never verified a second factor cannot keep refreshing once its
 * account needs one. The refusal is final: the refresh token is revoked and expired in the same transaction as the 401 (it
 * can never rotate later) and the access token of that session dies with it.
 */
@AutoConfigureMockMvc
class MfaRefreshIT extends AbstractIntegrationTest {

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

    private User account(UserRole role) {
        return auth.createAccount("mfa-refresh-" + UUID.randomUUID() + "@blog.local", role);
    }

    private ResultActions refresh(String refreshToken) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/refresh")
                .contentType(APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("refreshToken", refreshToken))));
    }

    private Map<String, Object> row(String refreshToken) {
        return jdbcTemplate.queryForMap(
                "SELECT revoked_at IS NOT NULL AS revoked, expires_at <= ? AS expired, mfa_verified_at "
                        + "FROM refresh_tokens WHERE token_hash = ?",
                Timestamp.from(Instant.now()),
                RefreshTokenService.hash(refreshToken));
    }

    @Test
    void an_admin_session_without_a_second_factor_is_refused_and_ended_for_good() throws Exception {
        User admin = account(UserRole.ADMIN);
        TokenResponse session = auth.unverifiedSession(admin);

        try (LogCapture logs = LogCapture.of(RefreshTokenService.class)) {
            refresh(session.refreshToken())
                    .andExpect(status().isUnauthorized())
                    .andExpect(jsonPath("$.error.code").value("MFA_REQUIRED"));

            assertThat(logs.messages()).contains("mfa session refused at refresh userId=" + admin.getId());
        }
        // Revoked AND expired: the token can never rotate later.
        assertThat(row(session.refreshToken())).containsEntry("revoked", true).containsEntry("expired", true);
        refresh(session.refreshToken())
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("REFRESH_TOKEN_EXPIRED"));
        // The access token of the session dies with it (its sid has no live token left).
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + session.accessToken()))
                .andExpect(status().isUnauthorized());
        // A new refresh row was never issued.
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT count(*) FROM refresh_tokens WHERE user_id = ?", Long.class, admin.getId()))
                .isEqualTo(1);
    }

    @Test
    void after_the_admin_enrols_the_old_refresh_token_can_never_come_back() throws Exception {
        // The upgrade story: an old refresh token of an ADMIN who had no second factor is refused at its next refresh,
        // and
        // enrolling afterwards, which satisfies the policy again, must not resurrect it.
        User admin = account(UserRole.ADMIN);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                passwordEncoder.encode("mat-khau-nang-cap"),
                admin.getId());
        TokenResponse old = auth.unverifiedSession(admin);
        refresh(old.refreshToken())
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("MFA_REQUIRED"));

        // Sign in and enrol through the real endpoints (the window is open on this development run).
        String challenge = objectMapper
                .readTree(mockMvc.perform(post("/api/v1/auth/login")
                                .contentType(APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(
                                        Map.of("email", admin.getEmail(), "password", "mat-khau-nang-cap"))))
                        .andExpect(status().isAccepted())
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .path("data")
                .path("challenge")
                .asString();
        JsonNode secret = objectMapper
                .readTree(mockMvc.perform(post("/api/v1/auth/mfa/enroll/begin")
                                .contentType(APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(Map.of("challenge", challenge))))
                        .andExpect(status().isOk())
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .path("data");
        String code = com.blog.auth.mfa.Totp.code(
                com.blog.auth.mfa.MfaSecrets.decode(secret.path("secretBase32").asString())
                        .orElseThrow(),
                com.blog.auth.mfa.Totp.stepOf(Instant.now()));
        mockMvc.perform(post("/api/v1/auth/mfa/enroll/confirm")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("challenge", challenge, "code", code))))
                .andExpect(status().isOk());

        refresh(old.refreshToken())
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("REFRESH_TOKEN_EXPIRED"));
    }

    @Test
    void an_enrolled_admin_whose_session_was_opened_without_the_second_factor_is_refused_too() throws Exception {
        User admin = account(UserRole.ADMIN);
        auth.enroll(admin);
        TokenResponse session = auth.unverifiedSession(admin);

        refresh(session.refreshToken())
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("MFA_REQUIRED"));

        assertThat(row(session.refreshToken())).containsEntry("revoked", true).containsEntry("expired", true);
    }

    @Test
    void an_enrolled_admin_with_a_verified_session_rotates_and_keeps_the_proof() throws Exception {
        User admin = account(UserRole.ADMIN);
        auth.enroll(admin);
        TokenResponse session = auth.verifiedSession(admin);

        String body = refresh(session.refreshToken())
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();

        String next =
                objectMapper.readTree(body).path("data").path("refreshToken").asString();
        assertThat(row(next).get("mfa_verified_at"))
                .as("the replacement row keeps the proof")
                .isNotNull();
    }

    @Test
    void an_author_without_an_enrollment_refreshes_as_before() throws Exception {
        User author = account(UserRole.AUTHOR);
        TokenResponse session = auth.unverifiedSession(author);

        refresh(session.refreshToken()).andExpect(status().isOk());
    }

    @Test
    void an_author_who_enrols_in_another_tab_loses_an_unverified_session_at_the_next_refresh() throws Exception {
        User author = account(UserRole.AUTHOR);
        TokenResponse session = auth.unverifiedSession(author);

        auth.enroll(author);

        refresh(session.refreshToken())
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("MFA_REQUIRED"));
        assertThat(row(session.refreshToken())).containsEntry("revoked", true).containsEntry("expired", true);
    }

    @Test
    void a_reader_never_needs_a_second_factor() throws Exception {
        User reader = auth.createReader(auth.nextGithubId(), "doc-gia-" + UUID.randomUUID());
        TokenResponse session = auth.unverifiedSession(reader);

        refresh(session.refreshToken()).andExpect(status().isOk());
    }

    @Test
    void an_abandoned_enrollment_does_not_make_an_author_need_a_second_factor() throws Exception {
        User author = account(UserRole.AUTHOR);
        jdbcTemplate.update(
                "INSERT INTO user_mfa (user_id, status, secret_cipher, key_id) VALUES (?, 'PENDING', '\\x00', 1)",
                author.getId());
        TokenResponse session = auth.unverifiedSession(author);

        refresh(session.refreshToken()).andExpect(status().isOk());
    }
}
