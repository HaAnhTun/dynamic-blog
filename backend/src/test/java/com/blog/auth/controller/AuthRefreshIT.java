package com.blog.auth.controller;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.auth.service.RefreshTokenService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@AutoConfigureMockMvc
class AuthRefreshIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    /** The admin's token pair after the whole two-step sign-in (password, then the code of the enrolled authenticator). */
    private JsonNode loginTokens() throws Exception {
        return objectMapper.valueToTree(auth.loginAsAdmin(mockMvc));
    }

    private String refresh(String refreshToken) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + refreshToken + "\"}"))
                .andReturn()
                .getResponse()
                .getContentAsString();
    }

    // Correctly signed so Spring Security's bearer-token filter accepts it, but with
    // expiresAt in the past, so the token is genuinely expired rather than garbage that
    // would be rejected for an unrelated reason and prove nothing.
    //
    // Built by TokenService, not here: this is a well-formed token, and a hand-built claim
    // set would drift the day a claim is added to mint while still passing.
    private String expiredAccessToken() {
        return auth.expiredBearerForAdmin().substring("Bearer ".length());
    }

    @Test
    void refreshIssuesANewPair() throws Exception {
        JsonNode first = loginTokens();

        String body = refresh(first.path("refreshToken").asString());
        JsonNode second = objectMapper.readTree(body).path("data");

        assertThat(second.path("accessToken").asString()).isNotBlank();
        assertThat(second.path("refreshToken").asString())
                .isNotBlank()
                .isNotEqualTo(first.path("refreshToken").asString());
    }

    @Test
    void theOldRefreshTokenStopsWorkingAfterRotation() throws Exception {
        String original = loginTokens().path("refreshToken").asString();
        refresh(original);

        mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + original + "\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("REFRESH_TOKEN_REVOKED"));
    }

    @Test
    void theRotatedAccessTokenActuallyWorks() throws Exception {
        String rotated = objectMapper
                .readTree(refresh(loginTokens().path("refreshToken").asString()))
                .path("data")
                .path("accessToken")
                .asString();

        // Without this, "refresh returns a new pair" could be satisfied by two random
        // strings. This is what proves the new access token authenticates.
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + rotated))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.email").value("admin@blog.local"));
    }

    @Test
    void anUnknownRefreshTokenIsRejected() throws Exception {
        mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content("{\"refreshToken\":\"never-issued-at-all\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("REFRESH_TOKEN_INVALID"));
    }

    @Test
    void logoutRevokesTheRefreshToken() throws Exception {
        String refreshToken = loginTokens().path("refreshToken").asString();

        mockMvc.perform(post("/api/v1/auth/logout")
                        .contentType(APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + refreshToken + "\"}"))
                .andExpect(status().isNoContent());

        mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + refreshToken + "\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("REFRESH_TOKEN_REVOKED"));
    }

    @Test
    void refreshWorksEvenWhenAnExpiredAccessTokenIsAttached() throws Exception {
        // Most HTTP clients attach whatever access token they hold to every request. With
        // a 15-minute access token and a 30-day refresh token, calling /refresh with an
        // already-expired access token still attached is the common case, not an edge one.
        String original = loginTokens().path("refreshToken").asString();

        String body = mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .header("Authorization", "Bearer " + expiredAccessToken())
                        .content("{\"refreshToken\":\"" + original + "\"}"))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();

        JsonNode rotated = objectMapper.readTree(body).path("data");
        assertThat(rotated.path("accessToken").asString()).isNotBlank();
        assertThat(rotated.path("refreshToken").asString()).isNotBlank().isNotEqualTo(original);
    }

    @Test
    void logoutRevokesEvenWhenAnExpiredAccessTokenIsAttached() throws Exception {
        String refreshToken = loginTokens().path("refreshToken").asString();

        mockMvc.perform(post("/api/v1/auth/logout")
                        .contentType(APPLICATION_JSON)
                        .header("Authorization", "Bearer " + expiredAccessToken())
                        .content("{\"refreshToken\":\"" + refreshToken + "\"}"))
                .andExpect(status().isNoContent());

        // A 204 alone would have passed against the broken version too, since the bug was
        // that revoke() never ran. The proof is that the refresh token is actually dead.
        mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + refreshToken + "\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("REFRESH_TOKEN_REVOKED"));
    }

    // --- Reuse detection (V6 P3-5) ------------------------------------------------------------------------
    //
    // A reader's session rather than the seeded admin's: detection revokes every live session of the account, and
    // the admin row is shared by the whole suite. The first token is issued the way a GitHub sign-in issues one; every
    // later step goes through the real endpoint, its transaction and the error envelope.

    @Test
    void aRefreshTokenReplayedAfterTheGraceWindowGets401AndKillsTheSessionItWasRotatedInto() throws Exception {
        String original = auth.verifiedRefreshToken(auth.createReader(auth.nextGithubId(), "replay-" + suffix()));
        String successor = objectMapper
                .readTree(refresh(original))
                .path("data")
                .path("refreshToken")
                .asString();
        assertThat(successor).isNotBlank();
        // The rotation happened three minutes ago: outside the default two-minute grace window.
        jdbcTemplate.update(
                "UPDATE refresh_tokens SET revoked_at = revoked_at - interval '3 minutes' " + "WHERE token_hash = ?",
                RefreshTokenService.hash(original));

        // Exactly the answer the frontend already handles for any revoked token: the contract does not change.
        mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + original + "\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("REFRESH_TOKEN_REVOKED"));
        // The revocation survived the 401 its own request answered: whoever holds the successor is logged out. A bulk
        // revocation also ends the token's life, so the answer is EXPIRED: the frontend drops the cookies instead of
        // treating it as a lost rotation race (V7a).
        mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + successor + "\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("REFRESH_TOKEN_EXPIRED"));
    }

    @Test
    void aReplayInsideTheGraceWindowIsALostRaceThatLeavesTheWinnersSessionAlive() throws Exception {
        String original = auth.verifiedRefreshToken(auth.createReader(auth.nextGithubId(), "race-" + suffix()));
        String successor = objectMapper
                .readTree(refresh(original))
                .path("data")
                .path("refreshToken")
                .asString();

        // Two requests of the frontend carrying the same cookie, seconds apart: the loser gets REVOKED...
        mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + original + "\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("REFRESH_TOKEN_REVOKED"));
        // ...and the winner's new token still works.
        mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + successor + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.refreshToken").isNotEmpty());
    }

    private static String suffix() {
        return UUID.randomUUID().toString().substring(0, 8);
    }
}
