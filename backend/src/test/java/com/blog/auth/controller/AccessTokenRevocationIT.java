package com.blog.auth.controller;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.auth.dto.RefreshRequest;
import com.blog.auth.dto.TokenResponse;
import com.blog.auth.service.AuthService;
import com.blog.auth.service.RefreshTokenService;
import com.blog.auth.service.TokenService;
import com.blog.common.exception.ApiException;
import com.blog.common.ratelimit.ClientAddress;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.repository.UserRepository;
import java.sql.Timestamp;
import java.time.Duration;
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
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

/**
 * JWT revocation end to end: an access token dies with its session (logout, sign out everywhere, reuse detection) and
 * with the account's {@code tokens_valid_after}; rotation keeps it alive. Every test uses its own account, because the
 * database is shared by the whole suite.
 */
@AutoConfigureMockMvc
class AccessTokenRevocationIT extends AbstractIntegrationTest {

    private static final ClientAddress CLIENT =
            ClientAddress.parse("203.0.113.9").orElseThrow();

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AuthService authService;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private TokenService tokenService;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Test
    void logout_ends_the_access_token_of_an_admin_at_once() throws Exception {
        TokenResponse session = sessionOf(account(UserRole.ADMIN));
        me(session).andExpect(status().isOk());
        adminUsers(session).andExpect(status().isOk());

        logout(session).andExpect(status().isNoContent());

        me(session).andExpect(status().isUnauthorized());
        adminUsers(session).andExpect(status().isUnauthorized());
    }

    @Test
    void logout_ends_the_access_token_of_a_reader_at_once() throws Exception {
        TokenResponse session = sessionOf(reader());
        me(session).andExpect(status().isOk());

        logout(session).andExpect(status().isNoContent());

        me(session).andExpect(status().isUnauthorized());
    }

    @Test
    void logout_of_one_session_leaves_the_other_sessions_of_the_same_person_alone() throws Exception {
        User user = reader();
        TokenResponse laptop = sessionOf(user);
        TokenResponse phone = sessionOf(user);

        logout(laptop).andExpect(status().isNoContent());

        me(laptop).andExpect(status().isUnauthorized());
        me(phone).andExpect(status().isOk());
    }

    @Test
    void rotation_keeps_the_session_alive_for_the_access_token_issued_before_it() throws Exception {
        TokenResponse first = sessionOf(reader());

        TokenResponse second = authService.refresh(new RefreshRequest(first.refreshToken()), CLIENT);

        // The old refresh token is revoked, but the session lives on: both access tokens still work.
        me(first).andExpect(status().isOk());
        me(second).andExpect(status().isOk());
        logout(second).andExpect(status().isNoContent());
        me(first).andExpect(status().isUnauthorized());
    }

    @Test
    void sign_out_everywhere_ends_every_session_and_access_token_of_the_caller_only() throws Exception {
        User user = reader();
        TokenResponse laptop = sessionOf(user);
        TokenResponse phone = sessionOf(user);
        TokenResponse someoneElse = sessionOf(reader());

        mockMvc.perform(post("/api/v1/auth/sessions/revoke-all").header("Authorization", bearer(laptop)))
                .andExpect(status().isNoContent());

        me(laptop).andExpect(status().isUnauthorized());
        me(phone).andExpect(status().isUnauthorized());
        me(someoneElse).andExpect(status().isOk());
        // A bulk revocation ends the expiry of the refresh tokens: EXPIRED, and no reuse detection.
        refresh(laptop)
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("REFRESH_TOKEN_EXPIRED"));
        refresh(phone)
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("REFRESH_TOKEN_EXPIRED"));
    }

    @Test
    void sign_out_everywhere_also_kills_a_sign_in_that_is_waiting_for_its_code() throws Exception {
        // Someone who knew the password started a sign-in; the owner signs out everywhere. The pending challenge
        // predates
        // the account's cut-off, so the code can no longer finish it.
        User admin = account(UserRole.ADMIN);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?",
                passwordEncoder.encode("mat-khau-dang-xuat-moi-noi"),
                admin.getId());
        AuthTestSupport.EnrolledAccount mfa = auth.enroll(admin);
        String challenge = objectMapper
                .readTree(mockMvc.perform(post("/api/v1/auth/login")
                                .contentType(APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(
                                        Map.of("email", admin.getEmail(), "password", "mat-khau-dang-xuat-moi-noi"))))
                        .andExpect(status().isAccepted())
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .path("data")
                .path("challenge")
                .asString();
        TokenResponse owner = sessionOf(admin);
        mockMvc.perform(post("/api/v1/auth/sessions/revoke-all").header("Authorization", bearer(owner)))
                .andExpect(status().isNoContent());

        mockMvc.perform(post("/api/v1/auth/mfa/verify")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("challenge", challenge, "code", mfa.code()))))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("MFA_CHALLENGE_INVALID"));
    }

    @Test
    void sign_out_everywhere_needs_authentication() throws Exception {
        mockMvc.perform(post("/api/v1/auth/sessions/revoke-all")).andExpect(status().isUnauthorized());
    }

    @Test
    void a_token_issued_before_tokens_valid_after_is_rejected_and_one_issued_after_is_accepted() throws Exception {
        User user = account(UserRole.AUTHOR);
        Instant now = Instant.now();
        String before = auth.bearerIssuedAt(user, now.minusSeconds(30));
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", before)).andExpect(status().isOk());

        new TransactionTemplate(transactionManager)
                .executeWithoutResult(s -> userRepository.bumpTokensValidAfter(user.getId(), now));

        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", before)).andExpect(status().isUnauthorized());
        // Minted in the same second as the bump: accepted, the comparison is at second resolution.
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", auth.bearerFor(user)))
                .andExpect(status().isOk());
    }

    @Test
    void refresh_token_reuse_after_the_grace_period_ends_the_access_tokens_of_that_session_only() throws Exception {
        User user = reader();
        TokenResponse stolen = sessionOf(user);
        TokenResponse rotated = authService.refresh(new RefreshRequest(stolen.refreshToken()), CLIENT);
        TokenResponse otherDevice = sessionOf(user);
        jdbcTemplate.update(
                "UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ?",
                Timestamp.from(Instant.now().minus(Duration.ofMinutes(3))),
                RefreshTokenService.hash(stolen.refreshToken()));

        assertThatThrownBy(() -> authService.refresh(new RefreshRequest(stolen.refreshToken()), CLIENT))
                .isInstanceOf(ApiException.class);

        // The session the replayed token belonged to is over, access tokens included. The person's other device is not
        // in
        // doubt (audit 104): its access token works, and the account cut-off was not moved.
        me(rotated).andExpect(status().isUnauthorized());
        me(otherDevice).andExpect(status().isOk());
    }

    @Test
    void an_access_token_without_a_session_claim_is_refused_even_though_the_signature_is_good() throws Exception {
        // Nothing mints a token without a session any more, so one can only be signed by somebody who holds the secret:
        // it is not waved through as a legacy token (audit 112). The control: the same account with a session is fine.
        User user = account(UserRole.AUTHOR);
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", auth.bearerFor(user)))
                .andExpect(status().isOk());

        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", auth.bearerWithoutSession(user)))
                .andExpect(status().isUnauthorized());
        mockMvc.perform(get("/api/v1/admin/users").header("Authorization", auth.bearerWithoutSession(user)))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void an_access_token_whose_session_belongs_to_another_account_is_refused() throws Exception {
        // The session of a reader, written into the token of an administrator. The session is live, but it is not the
        // administrator's, so it cannot stand in for one (audit 112).
        User admin = account(UserRole.ADMIN);
        TokenResponse readersSession = sessionOf(reader());
        String forged =
                "Bearer " + tokenService.mint(admin, Instant.now(), auth.sessionIdOf(readersSession), Instant.now());
        me(readersSession).andExpect(status().isOk());

        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", forged)).andExpect(status().isUnauthorized());
        mockMvc.perform(get("/api/v1/admin/users").header("Authorization", forged))
                .andExpect(status().isUnauthorized());
        // Control: the administrator's own session works.
        adminUsers(sessionOf(admin)).andExpect(status().isOk());
    }

    private TokenResponse sessionOf(User user) {
        return auth.verifiedSession(user);
    }

    private User reader() {
        return auth.createReader(
                auth.nextGithubId(), "thu-hoi-" + UUID.randomUUID().toString().substring(0, 8));
    }

    private User account(UserRole role) {
        return auth.createAccount("thu-hoi-" + UUID.randomUUID().toString().substring(0, 8) + "@blog.local", role);
    }

    private static String bearer(TokenResponse session) {
        return "Bearer " + session.accessToken();
    }

    private ResultActions me(TokenResponse session) throws Exception {
        return mockMvc.perform(get("/api/v1/auth/me").header("Authorization", bearer(session)));
    }

    private ResultActions adminUsers(TokenResponse session) throws Exception {
        return mockMvc.perform(get("/api/v1/admin/users").header("Authorization", bearer(session)));
    }

    private ResultActions logout(TokenResponse session) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/logout")
                .contentType(APPLICATION_JSON)
                .content("{\"refreshToken\":\"" + session.refreshToken() + "\"}"));
    }

    private ResultActions refresh(TokenResponse session) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/refresh")
                .contentType(APPLICATION_JSON)
                .content("{\"refreshToken\":\"" + session.refreshToken() + "\"}"));
    }
}
