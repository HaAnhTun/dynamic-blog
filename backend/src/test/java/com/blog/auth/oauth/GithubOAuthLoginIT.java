package com.blog.auth.oauth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.IThrowableProxy;
import ch.qos.logback.core.read.ListAppender;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.GithubLoginFlow;
import com.blog.support.GithubLoginFlow.Started;
import com.blog.support.GithubStub;
import com.blog.support.GithubStub.Failure;
import com.blog.user.entity.User;
import com.blog.user.entity.UserStatus;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.oauth2.client.web.OAuth2AuthorizationRequestRedirectFilter;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The full GitHub login round trip: the real Spring {@code oauth2Login}, a real HMAC-signed cookie,
 * a real DB, and GithubStub playing GitHub, including the way GitHub reports token-exchange errors with HTTP 200.
 *
 * Things the design relies on that are not visible from outside, pinned here:
 * <ul>
 *   <li>GitHub receives the site's callback at BOTH stages, even though the backend receives the callback at a different address;</li>
 *   <li>the token exchange uses the {@code redirect_uri} and {@code code_verifier} read back from the blob, and PKCE S256 is correct;</li>
 *   <li>no JSESSIONID, no session, at any stage;</li>
 *   <li>every error becomes an envelope with a code, no error becomes a 500;</li>
 *   <li>the log contains no token, code, state, secret or email.</li>
 * </ul>
 *
 * The GitHub id comes from {@link AuthTestSupport#nextGithubId()}: the DB is shared by the whole test suite and is never cleaned.
 */
@AutoConfigureMockMvc
class GithubOAuthLoginIT extends AbstractIntegrationTest {

    private static final UUID SEEDED_ADMIN = UUID.fromString("00000000-0000-0000-0000-000000000001");

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JwtDecoder jwtDecoder;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    private GithubLoginFlow flow;
    private String suffix;

    @BeforeEach
    void setUp() {
        GITHUB.reset();
        flow = new GithubLoginFlow(mockMvc, GITHUB);
        suffix = UUID.randomUUID().toString().substring(0, 8);
    }

    @AfterEach
    void resetStub() {
        GITHUB.reset();
    }

    // --- Start -------------------------------------------------------------------------------------------

    @Test
    void start_redirects_to_github_with_PKCE_S256_and_site_callback_with_signed_blob_and_no_session() throws Exception {
        Started started = flow.start();

        String location = started.authorizeUrl();
        assertThat(location).startsWith(GITHUB.authorizationUri() + "?");
        assertThat(GithubLoginFlow.queryParam(location, "response_type")).isEqualTo("code");
        assertThat(GithubLoginFlow.queryParam(location, "client_id")).isEqualTo(GithubStub.CLIENT_ID);
        assertThat(GithubLoginFlow.queryParam(location, "scope")).isEqualTo("read:user");
        assertThat(GithubLoginFlow.queryParam(location, "redirect_uri")).isEqualTo(GithubStub.REDIRECT_URI);
        assertThat(GithubLoginFlow.queryParam(location, "code_challenge_method"))
                .isEqualTo("S256");
        assertThat(GithubLoginFlow.queryParam(location, "code_challenge")).isNotBlank();
        assertThat(started.state()).isNotBlank();

        assertThat(started.response().getHeaders("Set-Cookie"))
                .singleElement()
                .asString()
                .startsWith("oauth2_auth_request=")
                .contains("Path=/api/v1/auth/oauth2")
                .contains("Max-Age=600")
                .contains("HttpOnly")
                .contains("SameSite=Lax");
        // Exactly the shape of the start route Next expects (FE/lib/oauth-flow-cookie.ts), and it fits in one cookie.
        assertThat(started.blob()).matches("^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$").hasSizeLessThan(3_000);
        assertNoSession(started.result());
    }

    @Test
    void unknown_registration_id_on_start_path_is_404_ENDPOINT_NOT_FOUND_like_when_oauth_is_disabled_not_500()
            throws Exception {
        Logger redirectFilter = (Logger) LoggerFactory.getLogger(OAuth2AuthorizationRequestRedirectFilter.class);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        redirectFilter.addAppender(logs);
        MvcResult result;
        try {
            result = mockMvc.perform(get(GithubLoginSecurityConfig.AUTHORIZATION_BASE_URI + "/gitlab"))
                    .andReturn();
        } finally {
            redirectFilter.detachAppender(logs);
        }

        MockHttpServletResponse response = result.getResponse();
        String body = response.getContentAsString();
        assertThat(response.getStatus()).as(body).isEqualTo(404);
        assertThat(objectMapper.readTree(body).path("error").path("code").asString())
                .isEqualTo("ENDPOINT_NOT_FOUND");
        assertThat(response.getHeader("Location")).isNull();
        assertThat(response.getHeaders("Set-Cookie")).isEmpty();
        assertNoSession(result);
        // No more WARN line with the redirect filter's stack trace for an unknown id.
        assertThat(logs.list).isEmpty();
        // A real id still takes the old path.
        assertThat(flow.start().authorizeUrl()).startsWith(GITHUB.authorizationUri() + "?");
    }

    // --- Account -----------------------------------------------------------------------------------------

    @Test
    void first_login_creates_USER_reader_without_email_and_returns_TokenResponse_like_password_login()
            throws Exception {
        long githubId = auth.nextGithubId();
        String login = "doc-gia-" + suffix;

        MvcResult result = flow.login(GithubStub.profile(githubId, login, "  Reader  Name\n" + suffix + " "));

        MockHttpServletResponse response = result.getResponse();
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
        assertThat(response.getContentType()).startsWith(APPLICATION_JSON.toString());
        assertThat(response.getHeader("Cache-Control")).contains("no-store");
        JsonNode data = objectMapper.readTree(response.getContentAsString()).path("data");
        assertThat(fieldNames(data))
                .containsExactlyInAnyOrder("accessToken", "refreshToken", "expiresIn", "refreshExpiresIn");
        assertThat(data.path("expiresIn").asLong()).isEqualTo(900);
        // A reader keeps the refresh token life of 30 days from each issue.
        assertThat(data.path("refreshExpiresIn").asLong()).isEqualTo(30L * 24 * 3600);

        Map<String, Object> row = jdbcTemplate.queryForMap(
                "SELECT id, email, password_hash, display_name, role, "
                        + "status, github_login, avatar_url, last_login_at FROM users WHERE github_id = ?",
                githubId);
        UUID userId = (UUID) row.get("id");
        assertThat(row.get("role")).isEqualTo("USER");
        assertThat(row.get("status")).isEqualTo("ACTIVE");
        assertThat(row.get("email")).isNull();
        assertThat(row.get("password_hash")).isNull();
        assertThat(row.get("display_name")).isEqualTo("Reader Name " + suffix);
        assertThat(row.get("github_login")).isEqualTo(login);
        assertThat(row.get("avatar_url")).isEqualTo("https://avatars.githubusercontent.com/u/" + githubId + "?v=4");
        assertThat(row.get("last_login_at")).isNotNull();

        Jwt jwt = jwtDecoder.decode(data.path("accessToken").asString());
        assertThat(jwt.getSubject()).isEqualTo(userId.toString());
        assertThat(jwt.getClaimAsString("role")).isEqualTo("USER");
        assertThat(refreshTokensOf(userId)).isEqualTo(1);
        // The same token pair as a password login: the refresh token rotates through that very endpoint.
        mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(APPLICATION_JSON)
                        .content("{\"refreshToken\":\""
                                + data.path("refreshToken").asString() + "\"}"))
                .andExpect(
                        result1 -> assertThat(result1.getResponse().getStatus()).isEqualTo(200));

        // GitHub receives the site's callback at both stages, and PKCE matches.
        assertThat(GITHUB.authorizeCalls()).singleElement().satisfies(call -> {
            assertThat(call.redirectUri()).isEqualTo(GithubStub.REDIRECT_URI);
            assertThat(call.codeChallengeMethod()).isEqualTo("S256");
            assertThat(call.codeChallengePresent()).isTrue();
        });
        assertThat(GITHUB.tokenCalls()).singleElement().satisfies(call -> {
            assertThat(call.redirectUri()).isEqualTo(GithubStub.REDIRECT_URI);
            assertThat(call.grantType()).isEqualTo("authorization_code");
            assertThat(call.clientAuthenticated()).isTrue();
            assertThat(call.pkceVerified()).isTrue();
            assertThat(call.result()).isEqualTo("ok");
        });

        // No session; this attempt's blob is removed.
        assertNoSession(result);
        assertFlowCookieCleared(result);
    }

    @Test
    void later_login_with_same_github_id_after_login_rename_is_same_account_with_new_login_name_and_avatar()
            throws Exception {
        long githubId = auth.nextGithubId();
        UUID first = subjectOf(flow.login(GithubStub.profile(githubId, "ten-cu-" + suffix, "Old Name")));

        Map<String, Object> renamed = GithubStub.profile(githubId, "ten-moi-" + suffix, "New Name");
        renamed.put("avatar_url", "https://avatars.githubusercontent.com/u/" + githubId + "?v=5");
        UUID second = subjectOf(flow.login(renamed));

        assertThat(second).isEqualTo(first);
        assertThat(usersWithGithubId(githubId)).isEqualTo(1);
        Map<String, Object> row = jdbcTemplate.queryForMap(
                "SELECT github_login, display_name, avatar_url FROM users WHERE id = ?", first);
        assertThat(row.get("github_login")).isEqualTo("ten-moi-" + suffix);
        assertThat(row.get("display_name")).isEqualTo("New Name");
        assertThat(row.get("avatar_url")).isEqualTo("https://avatars.githubusercontent.com/u/" + githubId + "?v=5");
    }

    @Test
    void github_person_with_admin_email_is_separate_reader_never_admin() throws Exception {
        long githubId = auth.nextGithubId();
        Map<String, Object> profile = GithubStub.profile(githubId, "mao-danh-" + suffix, "Admin");
        profile.put("email", "admin@blog.local");

        MvcResult result = flow.login(profile);

        UUID userId = subjectOf(result);
        assertThat(userId).isNotEqualTo(SEEDED_ADMIN);
        assertThat(roleOf(result)).isEqualTo("USER");
        assertThat(jdbcTemplate.queryForObject("SELECT email FROM users WHERE id = ?", String.class, userId))
                .isNull();
        Map<String, Object> admin =
                jdbcTemplate.queryForMap("SELECT email, role, github_id FROM users WHERE id = ?", SEEDED_ADMIN);
        assertThat(admin.get("email")).isEqualTo("admin@blog.local");
        assertThat(admin.get("role")).isEqualTo("ADMIN");
        assertThat(admin.get("github_id")).isEqualTo(GithubStub.ADMIN_GITHUB_ID);
    }

    @Test
    void ADMIN_GITHUB_ID_github_id_logs_in_as_the_seed_admin_itself_and_keeps_name_in_cms() throws Exception {
        AuthTestSupport.EnrolledAccount enrolled = auth.enrolledAdmin();
        MvcResult result =
                flow.login(GithubStub.profile(GithubStub.ADMIN_GITHUB_ID, "chu-site-" + suffix, "Name on GitHub"));

        // GitHub is a second way to become ADMIN, so it goes through the same gate as the password: a challenge, no
        // token.
        MockHttpServletResponse callback = result.getResponse();
        assertThat(callback.getStatus()).as(callback.getContentAsString()).isEqualTo(202);
        assertThat(callback.getContentAsString()).doesNotContain("accessToken").doesNotContain("refreshToken");
        assertThat(objectMapper
                        .readTree(callback.getContentAsString())
                        .path("data")
                        .path("purpose")
                        .asString())
                .isEqualTo("VERIFY");
        Jwt token = jwtDecoder.decode(
                auth.completeSecondStep(mockMvc, callback, enrolled).accessToken());

        assertThat(UUID.fromString(token.getSubject())).isEqualTo(SEEDED_ADMIN);
        assertThat(token.getClaimAsString("role")).isEqualTo("ADMIN");
        Map<String, Object> admin = jdbcTemplate.queryForMap(
                "SELECT email, role, display_name, github_login FROM users WHERE id = ?", SEEDED_ADMIN);
        assertThat(admin.get("role")).isEqualTo("ADMIN");
        assertThat(admin.get("email")).isEqualTo("admin@blog.local");
        // The ADMIN's name is managed by the CMS, not by GitHub; the login follows GitHub.
        assertThat(admin.get("display_name")).isEqualTo("Admin");
        assertThat(admin.get("github_login")).isEqualTo("chu-site-" + suffix);
        assertThat(usersWithGithubId(GithubStub.ADMIN_GITHUB_ID)).isEqualTo(1);
    }

    @Test
    void many_simultaneous_first_logins_of_one_id_create_only_one_row() throws Exception {
        long githubId = auth.nextGithubId();
        Map<String, Object> profile = GithubStub.profile(githubId, "cung-luc-" + suffix, "At Once");
        int logins = 4;
        List<Started> starts = new ArrayList<>();
        List<String> codes = new ArrayList<>();
        for (int i = 0; i < logins; i++) {
            Started started = flow.start();
            starts.add(started);
            codes.add(flow.approve(started, profile));
        }

        CountDownLatch go = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(logins);
        Set<UUID> subjects = new HashSet<>();
        try {
            List<Future<MvcResult>> results = new ArrayList<>();
            for (int i = 0; i < logins; i++) {
                Started started = starts.get(i);
                String code = codes.get(i);
                results.add(pool.submit(() -> {
                    go.await();
                    return flow.callback(started, code);
                }));
            }
            go.countDown();
            for (Future<MvcResult> result : results) {
                subjects.add(subjectOf(result.get(60, TimeUnit.SECONDS)));
            }
        } finally {
            pool.shutdownNow();
        }

        assertThat(subjects).hasSize(1);
        assertThat(usersWithGithubId(githubId)).isEqualTo(1);
    }

    // --- Errors ------------------------------------------------------------------------------------------

    @Test
    void clicking_cancel_on_github_is_401_OAUTH_ACCESS_DENIED() throws Exception {
        Started started = flow.start();

        MvcResult result = flow.callback(
                started.blob(),
                "error",
                "access_denied",
                "error_description",
                "The user has denied your application access.",
                "state",
                started.state());

        assertError(result, 401, "OAUTH_ACCESS_DENIED");
        assertThat(GITHUB.tokenCalls()).isEmpty();
    }

    @Test
    void
            fake_state_missing_cookie_tampered_cookie_or_missing_state_are_all_OAUTH_STATE_INVALID_and_do_not_burn_real_attempt()
                    throws Exception {
        long githubId = auth.nextGithubId();
        Started started = flow.start();
        String code = flow.approve(started, GithubStub.profile(githubId, "state-" + suffix, "State"));
        String blob = started.blob();
        String tampered = (blob.charAt(0) == 'A' ? 'B' : 'A') + blob.substring(1);

        // Login CSRF: someone else's callback URL carries their state, which does not match the blob in this browser.
        // The callback
        // reached the blob store, so the response clears the cookie like every other response from there.
        MvcResult mismatch = flow.callback(blob, "code", code, "state", "state-cua-ke-khac");
        assertError(mismatch, 401, "OAUTH_STATE_INVALID");
        assertFlowCookieCleared(mismatch);
        assertError(flow.callback(null, "code", code, "state", started.state()), 401, "OAUTH_STATE_INVALID");
        assertError(flow.callback(tampered, "code", code, "state", started.state()), 401, "OAUTH_STATE_INVALID");
        // Not an authorize response (missing state): invalid_request. Spring throws this before asking the blob
        // store, so this response does NOT clear the cookie; Next's callback route clears its own flow cookie every
        // time.
        MvcResult notAuthorizationResponse = flow.callback(blob, "code", code);
        assertError(notAuthorizationResponse, 401, "OAUTH_STATE_INVALID");
        assertThat(notAuthorizationResponse.getResponse().getHeaders("Set-Cookie"))
                .isEmpty();
        assertThat(GITHUB.tokenCalls()).isEmpty();
        assertThat(usersWithGithubId(githubId)).isZero();

        // None of the above marked the real state as consumed: the real login attempt still completes.
        assertThat(subjectOf(flow.callback(started, code))).isNotNull();
    }

    @Test
    void second_callback_replay_is_OAUTH_STATE_INVALID_never_reaches_github_and_still_one_row() throws Exception {
        long githubId = auth.nextGithubId();
        Started started = flow.start();
        String code = flow.approve(started, GithubStub.profile(githubId, "phat-lai-" + suffix, "Replayed"));
        UUID userId = subjectOf(flow.callback(started, code));

        MvcResult replay = flow.callback(started, code);
        assertError(replay, 401, "OAUTH_STATE_INVALID");
        assertFlowCookieCleared(replay);

        assertThat(usersWithGithubId(githubId)).isEqualTo(1);
        assertThat(GITHUB.tokenCalls()).hasSize(1);
        assertThat(refreshTokensOf(userId)).isEqualTo(1);
    }

    static Stream<Arguments> githubOutages() {
        return Stream.of(
                Arguments.of("token", Failure.SERVER_ERROR),
                Arguments.of("token", Failure.DISCONNECT),
                Arguments.of("user", Failure.SERVER_ERROR),
                Arguments.of("user", Failure.DISCONNECT));
    }

    @ParameterizedTest(name = "leg {0}: {1}")
    @MethodSource("githubOutages")
    void github_5xx_or_dropped_connection_at_any_stage_is_502_OAUTH_PROVIDER_UNAVAILABLE(String leg, Failure failure)
            throws Exception {
        long githubId = auth.nextGithubId();
        Started started = flow.start();
        String code = flow.approve(started, GithubStub.profile(githubId, "sap-" + suffix, "GitHub Down"));
        if (leg.equals("token")) {
            GITHUB.failToken(failure);
        } else {
            GITHUB.failUserInfo(failure);
        }

        assertError(flow.callback(started, code), 502, "OAUTH_PROVIDER_UNAVAILABLE");
        assertThat(usersWithGithubId(githubId)).isZero();
    }

    @Test
    void wrong_or_used_code_github_200_with_error_is_401_OAUTH_LOGIN_FAILED_not_502() throws Exception {
        Started unknownCode = flow.start();
        assertError(flow.callback(unknownCode, "code-khong-ton-tai-" + suffix), 401, "OAUTH_LOGIN_FAILED");
        assertThat(GITHUB.tokenCalls())
                .singleElement()
                .satisfies(call -> assertThat(call.result()).isEqualTo("bad_verification_code"));

        // A code that has been used up, taken to a new login attempt (new state, new blob): GitHub also returns 200
        // with an error.
        long githubId = auth.nextGithubId();
        Started first = flow.start();
        String used = flow.approve(first, GithubStub.profile(githubId, "code-cu-" + suffix, "Old Code"));
        subjectOf(flow.callback(first, used));
        Started second = flow.start();
        assertError(flow.callback(second, used), 401, "OAUTH_LOGIN_FAILED");
        assertThat(GITHUB.tokenCalls())
                .last()
                .satisfies(call -> assertThat(call.result()).isEqualTo("bad_verification_code"));
    }

    @Test
    void malformed_github_profile_is_401_OAUTH_LOGIN_FAILED_not_500_and_writes_nothing() throws Exception {
        long githubId = auth.nextGithubId();
        Map<String, Object> stringId = GithubStub.profile(githubId, "id-chuoi-" + suffix, "String Id");
        stringId.put("id", String.valueOf(githubId));
        Map<String, Object> missingId = GithubStub.profile(githubId, "thieu-id-" + suffix, "Missing Id");
        missingId.remove("id");
        Map<String, Object> missingLogin = GithubStub.profile(githubId, "thieu-login-" + suffix, "Missing Login");
        missingLogin.remove("login");
        Map<String, Object> invalidLogin = GithubStub.profile(githubId, "a/b", "Login Sai");
        Map<String, Object> negativeId = GithubStub.profile(-githubId, "id-am-" + suffix, "Negative Id");

        for (Map<String, Object> profile : List.of(stringId, missingId, missingLogin, invalidLogin, negativeId)) {
            assertError(flow.login(profile), 401, "OAUTH_LOGIN_FAILED");
        }
        assertThat(usersWithGithubId(githubId)).isZero();
    }

    @Test
    void suspended_account_gets_403_USER_SUSPENDED_and_no_refresh_token_issued() throws Exception {
        long githubId = auth.nextGithubId();
        User reader = auth.createReader(githubId, "bi-khoa-" + suffix, UserStatus.SUSPENDED);
        Map<String, Object> before = profileRowOf(reader.getId());

        // The locked person changes name, login and avatar on GitHub and then clicks login.
        Map<String, Object> renamed = GithubStub.profile(githubId, "spam-" + suffix, "Buy cheap at spam.example");
        renamed.put("avatar_url", "https://avatars.githubusercontent.com/u/" + githubId + "?v=9");
        assertError(flow.login(renamed), 403, "USER_SUSPENDED");

        assertThat(refreshTokensOf(reader.getId())).isZero();
        assertThat(jdbcTemplate.queryForObject("SELECT status FROM users WHERE id = ?", String.class, reader.getId()))
                .isEqualTo("SUSPENDED");
        assertThat(usersWithGithubId(githubId)).isEqualTo(1);
        // The rejected login writes nothing: the comments still displayed keep the old name, login and avatar, and the
        // admin
        // page does not see a "latest login" that never happened.
        assertThat(profileRowOf(reader.getId())).isEqualTo(before);
        assertThat(before.get("display_name")).isEqualTo("Reader bi-khoa-" + suffix);
    }

    @Test
    void unlock_then_login_again_writes_new_github_profile_as_usual() throws Exception {
        long githubId = auth.nextGithubId();
        User reader = auth.createReader(githubId, "mo-khoa-" + suffix, UserStatus.SUSPENDED);
        assertError(
                flow.login(GithubStub.profile(githubId, "mo-khoa-moi-" + suffix, "New Name")), 403, "USER_SUSPENDED");

        auth.setStatus(reader.getId(), UserStatus.ACTIVE);
        MvcResult result = flow.login(GithubStub.profile(githubId, "mo-khoa-moi-" + suffix, "New Name"));

        assertThat(subjectOf(result)).isEqualTo(reader.getId());
        Map<String, Object> row = profileRowOf(reader.getId());
        assertThat(row.get("github_login")).isEqualTo("mo-khoa-moi-" + suffix);
        assertThat(row.get("display_name")).isEqualTo("New Name");
        assertThat(refreshTokensOf(reader.getId())).isEqualTo(1);
    }

    // --- Log ---------------------------------------------------------------------------------------------

    @Test
    void log_contains_no_token_code_state_secret_or_email() throws Exception {
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        Set<String> secrets = new HashSet<>();
        try {
            long githubId = auth.nextGithubId();
            Map<String, Object> profile = GithubStub.profile(githubId, "log-" + suffix, "Log " + suffix);
            Started success = flow.start();
            MvcResult ok = flow.callback(success, flow.approve(success, profile));
            JsonNode tokens =
                    objectMapper.readTree(ok.getResponse().getContentAsString()).path("data");
            Started badCode = flow.start();
            assertError(flow.callback(badCode, "code-sai-" + suffix), 401, "OAUTH_LOGIN_FAILED");
            Started denied = flow.start();
            assertError(
                    flow.callback(
                            denied.blob(),
                            "error",
                            "access_denied",
                            "state",
                            denied.state(),
                            "error_description",
                            "mo-ta-loi-" + suffix),
                    401,
                    "OAUTH_ACCESS_DENIED");
            Started forged = flow.start();
            assertError(
                    flow.callback(forged.blob(), "code", "code-gia-" + suffix, "state", "state-gia-" + suffix),
                    401,
                    "OAUTH_STATE_INVALID");

            secrets.addAll(GITHUB.issuedAccessTokens());
            secrets.addAll(GITHUB.issuedCodes());
            secrets.addAll(List.of(
                    tokens.path("accessToken").asString(),
                    tokens.path("refreshToken").asString(),
                    success.state(),
                    badCode.state(),
                    denied.state(),
                    forged.state(),
                    success.blob(),
                    badCode.blob(),
                    denied.blob(),
                    forged.blob(),
                    "code-sai-" + suffix,
                    "code-gia-" + suffix,
                    "state-gia-" + suffix,
                    "mo-ta-loi-" + suffix,
                    (String) profile.get("email"),
                    GithubStub.CLIENT_SECRET,
                    Base64.getEncoder()
                            .encodeToString((GithubStub.CLIENT_ID + ":" + GithubStub.CLIENT_SECRET)
                                    .getBytes(StandardCharsets.UTF_8))));
            assertThat(GITHUB.issuedAccessTokens()).isNotEmpty();
        } finally {
            root.detachAppender(logs);
        }

        List<String> lines =
                logs.list.stream().map(GithubOAuthLoginIT::fullText).toList();
        // Control: the lines of the real login are among what is checked.
        assertThat(lines).anyMatch(line -> line.contains("github login ok"));
        assertThat(lines).anyMatch(line -> line.contains("github login failed error=OAUTH_LOGIN_FAILED"));
        assertThat(lines).anyMatch(line -> line.contains("github login failed error=OAUTH_ACCESS_DENIED"));
        for (String line : lines) {
            assertThat(line).doesNotContain("eyJ").doesNotContain("code=").doesNotContain("gho_");
            for (String secret : secrets) {
                assertThat(line).doesNotContain(secret);
            }
        }
    }

    // --- Helpers -----------------------------------------------------------------------------------------

    private UUID subjectOf(MvcResult result) throws Exception {
        return UUID.fromString(accessTokenOf(result).getSubject());
    }

    private String roleOf(MvcResult result) throws Exception {
        return accessTokenOf(result).getClaimAsString("role");
    }

    private Jwt accessTokenOf(MvcResult result) throws Exception {
        MockHttpServletResponse response = result.getResponse();
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
        return jwtDecoder.decode(objectMapper
                .readTree(response.getContentAsString())
                .path("data")
                .path("accessToken")
                .asString());
    }

    /** An error envelope with a code and traceId, no token, no cache, no session. */
    private void assertError(MvcResult result, int status, String code) throws Exception {
        MockHttpServletResponse response = result.getResponse();
        String body = response.getContentAsString();
        assertThat(response.getStatus()).as(body).isEqualTo(status);
        JsonNode error = objectMapper.readTree(body).path("error");
        assertThat(error.path("code").asString()).as(body).isEqualTo(code);
        assertThat(error.path("message").asString()).isNotBlank();
        assertThat(error.path("traceId").asString()).isNotBlank();
        assertThat(body).doesNotContain("accessToken").doesNotContain("refreshToken");
        assertThat(response.getHeader("Cache-Control")).contains("no-store");
        assertNoSession(result);
    }

    private static void assertNoSession(MvcResult result) {
        assertThat(result.getRequest().getSession(false)).isNull();
        assertThat(result.getResponse().getHeaders("Set-Cookie")).noneMatch(cookie -> cookie.startsWith("JSESSIONID"));
    }

    /**
     * A response that clears the blob: exactly one empty Set-Cookie with Max-Age=0. True for every callback that reaches the blob store (success,
     * state mismatch, second replay), not for a callback Spring rejects earlier (invalid_request).
     */
    private static void assertFlowCookieCleared(MvcResult result) {
        assertThat(result.getResponse().getHeaders("Set-Cookie"))
                .singleElement()
                .asString()
                .startsWith("oauth2_auth_request=;")
                .contains("Max-Age=0");
    }

    private long usersWithGithubId(long githubId) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM users WHERE github_id = ?", Long.class, githubId);
    }

    /** The profile columns a GitHub login may write. */
    private Map<String, Object> profileRowOf(UUID userId) {
        return jdbcTemplate.queryForMap(
                "SELECT github_login, display_name, avatar_url, last_login_at, updated_at " + "FROM users WHERE id = ?",
                userId);
    }

    private long refreshTokensOf(UUID userId) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM refresh_tokens WHERE user_id = ?", Long.class, userId);
    }

    private static List<String> fieldNames(JsonNode node) {
        List<String> names = new ArrayList<>();
        node.propertyNames().forEach(names::add);
        return names;
    }

    /** The formatted message, plus the class name and message of the whole accompanying exception chain. */
    private static String fullText(ILoggingEvent event) {
        StringBuilder text = new StringBuilder(event.getFormattedMessage());
        for (IThrowableProxy proxy = event.getThrowableProxy(); proxy != null; proxy = proxy.getCause()) {
            text.append(" | ").append(proxy.getClassName()).append(": ").append(proxy.getMessage());
        }
        return text.toString();
    }
}
