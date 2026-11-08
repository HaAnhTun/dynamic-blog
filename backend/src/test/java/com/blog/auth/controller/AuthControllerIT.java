package com.blog.auth.controller;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.auth.repository.RefreshTokenRepository;
import com.blog.auth.service.RefreshTokenService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import com.blog.user.repository.UserRepository;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
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
import org.springframework.security.oauth2.jwt.JwsHeader;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

@AutoConfigureMockMvc
class AuthControllerIT extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JwtEncoder jwtEncoder;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private JwtDecoder jwtDecoder;

    @Autowired
    private RefreshTokenRepository refreshTokenRepository;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void loginReturnsBothTokensWhenNoSecondFactorApplies() throws Exception {
        // An author without two-step verification: a password and nothing else. (An admin's login has a second step,
        // see the next test and MfaLoginIT.)
        User author = auth.createAccount("login-" + UUID.randomUUID() + "@blog.local", UserRole.AUTHOR);
        author.setPasswordHash(passwordEncoder.encode("mat-khau-tac-gia-khong-mfa"));
        userRepository.save(author);

        mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content("{\"email\":\"" + author.getEmail()
                                + "\",\"password\":\"mat-khau-tac-gia-khong-mfa\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.accessToken").isNotEmpty())
                .andExpect(jsonPath("$.data.refreshToken").isNotEmpty())
                .andExpect(jsonPath("$.data.expiresIn").value(900))
                // An author's session lives 7 days without use: the cookie of the frontend ends with it (audit 007).
                .andExpect(jsonPath("$.data.refreshExpiresIn").value(7 * 24 * 3600));
    }

    @Test
    void anAdminsPasswordAloneReturnsAChallengeAndNoToken() throws Exception {
        auth.enrolledAdmin();

        String body = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content("{\"email\":\"admin@blog.local\",\"password\":\"admin12345\"}"))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.data.challenge").isNotEmpty())
                .andExpect(jsonPath("$.data.purpose").value("VERIFY"))
                .andExpect(jsonPath("$.data.expiresIn").value(300))
                .andExpect(jsonPath("$.data.enrollmentCodeRequired").value(false))
                .andReturn()
                .getResponse()
                .getContentAsString();

        // A client that knows nothing about two-step verification finds no token to use.
        assertThat(body).doesNotContain("accessToken").doesNotContain("refreshToken");
    }

    @Test
    void aLoginOpensASessionThatRemembersWhenThePersonSignedInAndThatNoSecondFactorWasVerified() throws Exception {
        // An author without two-step verification: the first factor is all there is. (The admin's login has its own
        // second step, tested in MfaLoginIT.)
        User author = auth.createAccount("proof-" + UUID.randomUUID() + "@blog.local", UserRole.AUTHOR);
        author.setPasswordHash(passwordEncoder.encode("mot-mat-khau-dai-du-dung"));
        userRepository.save(author);
        Instant before = Instant.now().minusSeconds(2);

        String body = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content("{\"email\":\"" + author.getEmail() + "\",\"password\":\"mot-mat-khau-dai-du-dung\"}"))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();

        var data = objectMapper.readTree(body).path("data");
        var row = refreshTokenRepository
                .findByTokenHash(
                        RefreshTokenService.hash(data.path("refreshToken").asString()))
                .orElseThrow();
        assertThat(row.getAuthenticatedAt()).isBetween(before, Instant.now().plusSeconds(2));
        assertThat(row.getMfaVerifiedAt()).isNull();
        var jwt = jwtDecoder.decode(data.path("accessToken").asString());
        assertThat(jwt.getClaimAsString("sid")).isEqualTo(row.getSessionId().toString());
        assertThat(jwt.<Number>getClaim("auth_time").longValue())
                .isEqualTo(row.getAuthenticatedAt().getEpochSecond());

        // Refreshing keeps the start of the session: the new access token says the person signed in at the same moment.
        String refreshed = mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content("{\"refreshToken\":\""
                                + data.path("refreshToken").asString() + "\"}"))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();
        var refreshedJwt = jwtDecoder.decode(objectMapper
                .readTree(refreshed)
                .path("data")
                .path("accessToken")
                .asString());
        assertThat(refreshedJwt.<Number>getClaim("auth_time").longValue())
                .isEqualTo(row.getAuthenticatedAt().getEpochSecond());
        assertThat(refreshedJwt.getClaimAsString("sid"))
                .isEqualTo(row.getSessionId().toString());
    }

    @Test
    void wrongPasswordAndUnknownEmailAreIndistinguishable() throws Exception {
        String wrongPassword = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content("{\"email\":\"admin@blog.local\",\"password\":\"nope\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("INVALID_CREDENTIALS"))
                .andReturn()
                .getResponse()
                .getContentAsString();

        String unknownEmail = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content("{\"email\":\"nobody@blog.local\",\"password\":\"admin12345\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("INVALID_CREDENTIALS"))
                .andReturn()
                .getResponse()
                .getContentAsString();

        // The messages must match too. A different message for each case tells an attacker
        // which addresses have accounts, which is the thing the shared code is for.
        JsonNode a = objectMapper.readTree(wrongPassword).path("error");
        JsonNode b = objectMapper.readTree(unknownEmail).path("error");
        assertThat(a.path("message").asString()).isEqualTo(b.path("message").asString());
    }

    @Test
    void loginWithAMalformedBodyAnswersTheProjectEnvelope() throws Exception {
        mockMvc.perform(post("/api/v1/auth/login").contentType(APPLICATION_JSON).content("{\"email\":\"\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"))
                .andExpect(jsonPath("$.error.traceId").isNotEmpty());
    }

    @Test
    void meReturnsTheAuthenticatedUser() throws Exception {
        String token = auth.loginAsAdmin(mockMvc).accessToken();

        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value("00000000-0000-0000-0000-000000000001"))
                .andExpect(jsonPath("$.data.email").value("admin@blog.local"))
                .andExpect(jsonPath("$.data.role").value("ADMIN"))
                .andExpect(jsonPath("$.data.displayName").value("Admin"))
                // githubLogin/avatarUrl of the admin are not value-checked: they change when the admin is linked to
                // GitHub
                // (ADMIN_GITHUB_ID) in another test of the same JVM.
                .andExpect(jsonPath("$.data.status").value("ACTIVE"))
                .andExpect(jsonPath("$.data.createdAt").isNotEmpty());
    }

    @Test
    void meWithoutATokenIsUnauthorized() throws Exception {
        // Paired with the test above, which proves the endpoint answers 200 for a real
        // token — so this 401 is about the missing token and not a broken route.
        mockMvc.perform(get("/api/v1/auth/me")).andExpect(status().isUnauthorized());
    }

    @Test
    void theLoginResponseDoesNotLeakThePasswordHash() throws Exception {
        String body = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content("{\"email\":\"admin@blog.local\",\"password\":\"admin12345\"}"))
                .andReturn()
                .getResponse()
                .getContentAsString();

        assertThat(body).doesNotContain("$argon2id$");
        assertThat(body).doesNotContain("passwordHash");
    }

    @Test
    void aTokenWhoseSubjectIsNotAUuidIsRejectedAsUnauthenticated() throws Exception {
        // Signed with the real key, so the filter chain accepts it and the failure happens
        // in our own code. Before requireUserId caught it, this was a 500 with a stack
        // trace rather than a 401.
        Instant now = Instant.now();
        String token = jwtEncoder
                .encode(JwtEncoderParameters.from(
                        JwsHeader.with(() -> "HS256").build(),
                        JwtClaimsSet.builder()
                                .subject("not-a-uuid-at-all")
                                .issuedAt(now)
                                .expiresAt(now.plusSeconds(900))
                                .claim("role", "ADMIN")
                                .build()))
                .getTokenValue();

        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("UNAUTHENTICATED"));
    }

    @Test
    void aTokenWithNoSubjectAtAllIsRejectedAsUnauthenticated() throws Exception {
        // No .subject(...) call. An empty string would not reproduce this: JwtClaimsSet
        // drops empty-string claims, so the token carries no `sub` key either way, and a
        // test written with .subject("") would be exercising this same null path while
        // looking like it exercised a different one.
        Instant now = Instant.now();
        String token = jwtEncoder
                .encode(JwtEncoderParameters.from(
                        JwsHeader.with(() -> "HS256").build(),
                        JwtClaimsSet.builder()
                                .issuedAt(now)
                                .expiresAt(now.plusSeconds(900))
                                .claim("role", "ADMIN")
                                .build()))
                .getTokenValue();

        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + token))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("UNAUTHENTICATED"));
    }

    // --- Password check limit -------------------------------------------------------------------------

    @Test
    void several_correct_logins_at_once_all_succeed_and_none_gets_429() throws Exception {
        // Only app.rate-limit.login.concurrent (default 2) Argon2 runs execute at the same time; others wait their
        // turn, up to 5 seconds.
        // At the load of a single site owner (a few tabs, a few retries), that queue must drain fully, with nobody
        // rejected by mistake.
        String email = "dang-nhap-cung-luc-" + UUID.randomUUID() + "@blog.local";
        String password = "mat-khau-dang-nhap-cung-luc";
        User account = auth.createAccount(email, UserRole.AUTHOR);
        account.setPasswordHash(passwordEncoder.encode(password));
        userRepository.save(account);

        int callers = 6;
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(callers);
        try {
            List<Future<MvcResult>> results = new ArrayList<>();
            for (int i = 0; i < callers; i++) {
                results.add(pool.submit(() -> {
                    assertThat(start.await(10, TimeUnit.SECONDS)).isTrue();
                    return mockMvc.perform(post("/api/v1/auth/login")
                                    .contentType(APPLICATION_JSON)
                                    .content("{\"email\":\"" + email + "\",\"password\":\"" + password + "\"}"))
                            .andReturn();
                }));
            }
            start.countDown();
            for (Future<MvcResult> result : results) {
                MockHttpServletResponse response =
                        result.get(60, TimeUnit.SECONDS).getResponse();
                assertThat(response.getStatus())
                        .as(response.getContentAsString())
                        .isEqualTo(200);
            }
        } finally {
            pool.shutdownNow();
        }
        // Each time a real token pair, never aborted midway.
        assertThat(refreshTokenCount(account.getId())).isEqualTo(callers);
    }

    // --- GitHub readers and suspension ---------------------------------------------------------------

    @Test
    void account_without_password_cannot_log_in_by_password_and_gets_unknown_email_message() throws Exception {
        // The GitHub login never stores a GitHub email, but the schema allows a GitHub account to have an email without
        // a password
        // (only github_id is required). A password login against it must be an ordinary wrong password, not a 500.
        String email = "github-only-" + UUID.randomUUID() + "@blog.local";
        User reader = auth.createReader(auth.nextGithubId(), "github-only");
        reader.setEmail(email);
        userRepository.save(reader);

        String githubOnly = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content("{\"email\":\"" + email + "\",\"password\":\"bat-ky-mat-khau-nao\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("INVALID_CREDENTIALS"))
                .andReturn()
                .getResponse()
                .getContentAsString();
        String unknownEmail = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content("{\"email\":\"nobody-" + UUID.randomUUID() + "@blog.local\","
                                + "\"password\":\"bat-ky-mat-khau-nao\"}"))
                .andExpect(status().isUnauthorized())
                .andReturn()
                .getResponse()
                .getContentAsString();

        assertThat(objectMapper
                        .readTree(githubOnly)
                        .path("error")
                        .path("message")
                        .asString())
                .isEqualTo(objectMapper
                        .readTree(unknownEmail)
                        .path("error")
                        .path("message")
                        .asString());
        assertThat(refreshTokenCount(reader.getId())).isZero();
    }

    @Test
    void suspended_account_with_correct_password_gets_403_USER_SUSPENDED_wrong_password_still_401_and_no_token()
            throws Exception {
        // Only the USER role can be suspended, and a real USER has no password: this is the defence for a row created
        // by
        // SQL, exactly as the design requires.
        String email = "suspended-" + UUID.randomUUID() + "@blog.local";
        User account = auth.createAccount(email, UserRole.USER);
        account.setPasswordHash(passwordEncoder.encode("mat-khau-cua-nguoi-bi-khoa"));
        userRepository.save(account);
        auth.setStatus(account.getId(), UserStatus.SUSPENDED);

        mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content("{\"email\":\"" + email + "\",\"password\":\"mat-khau-cua-nguoi-bi-khoa\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("USER_SUSPENDED"));
        // A wrong password is still just a wrong password: nobody can probe which account is locked.
        mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content("{\"email\":\"" + email + "\",\"password\":\"sai-mat-khau\"}"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("INVALID_CREDENTIALS"));

        assertThat(refreshTokenCount(account.getId())).isZero();
    }

    @Test
    void me_of_reader_returns_all_v5_fields_and_no_other() throws Exception {
        long githubId = auth.nextGithubId();
        User reader = auth.createReader(githubId, "me-doc-gia");

        String body = mockMvc.perform(get("/api/v1/auth/me").header("Authorization", auth.bearerFor(reader)))
                .andExpect(status().isOk())
                .andReturn()
                .getResponse()
                .getContentAsString();

        JsonNode data = objectMapper.readTree(body).path("data");
        // Exactly the eight fields of CurrentUserResponse: no github_id, no hash, no token.
        List<String> names = new ArrayList<>();
        data.propertyNames().forEach(names::add);
        assertThat(names)
                .containsExactlyInAnyOrder(
                        "id", "email", "displayName", "role", "githubLogin", "avatarUrl", "status", "createdAt");
        assertThat(data.path("id").asString()).isEqualTo(reader.getId().toString());
        assertThat(data.path("email").isNull()).isTrue();
        assertThat(data.path("displayName").asString()).isEqualTo("Reader me-doc-gia");
        assertThat(data.path("role").asString()).isEqualTo("USER");
        assertThat(data.path("githubLogin").asString()).isEqualTo("me-doc-gia");
        assertThat(data.path("avatarUrl").asString())
                .isEqualTo("https://avatars.githubusercontent.com/u/" + githubId + "?v=4");
        assertThat(data.path("status").asString()).isEqualTo("ACTIVE");
        assertThat(Instant.parse(data.path("createdAt").asString()))
                .isBetween(
                        Instant.now().minus(5, ChronoUnit.MINUTES),
                        Instant.now().plus(1, ChronoUnit.MINUTES));
    }

    @Test
    void me_of_suspended_account_gets_403_USER_SUSPENDED_even_with_valid_access_token() throws Exception {
        User reader = auth.createReader(auth.nextGithubId(), "me-bi-khoa");
        String token = auth.bearerFor(reader);
        // Control: the same token returns 200 before the lock.
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", token)).andExpect(status().isOk());

        auth.setStatus(reader.getId(), UserStatus.SUSPENDED);

        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", token))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("USER_SUSPENDED"));
    }

    @Test
    void refresh_of_suspended_account_gets_403_USER_SUSPENDED() throws Exception {
        User reader = auth.createReader(auth.nextGithubId(), "refresh-bi-khoa");
        String refreshToken = auth.verifiedRefreshToken(reader);
        auth.setStatus(reader.getId(), UserStatus.SUSPENDED);

        mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + refreshToken + "\"}"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.error.code").value("USER_SUSPENDED"));
    }

    private long refreshTokenCount(UUID userId) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM refresh_tokens WHERE user_id = ?", Long.class, userId);
    }
}
