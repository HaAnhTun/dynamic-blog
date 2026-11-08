package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.auth.mfa.RecoveryCodes;
import com.blog.auth.service.RefreshTokenService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.AuthTestSupport.EnrolledAccount;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
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
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The two-step sign-in over HTTP, on throw-away ADMIN accounts of their own (the shared seeded admin keeps its state for
 * the other test classes): the password answers 202 with a challenge and no token, the code answers with the session.
 * Replay, single use, the one answer for every dead challenge, the live-challenge ceiling, the cut-off and the order of
 * the checks are each pinned here.
 */
@AutoConfigureMockMvc
class MfaLoginIT extends AbstractIntegrationTest {

    private static final String PASSWORD = "mat-khau-cua-quan-tri-thu-nghiem";

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

    private User admin() {
        User admin = auth.createAccount("mfa-login-" + UUID.randomUUID() + "@blog.local", UserRole.ADMIN);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?", passwordEncoder.encode(PASSWORD), admin.getId());
        return admin;
    }

    private MockHttpServletResponse login(String email, String password) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("email", email, "password", password))))
                .andReturn()
                .getResponse();
    }

    private String challengeOf(User account) throws Exception {
        MockHttpServletResponse response = login(account.getEmail(), PASSWORD);
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(202);
        return json(response).path("data").path("challenge").asString();
    }

    private MockHttpServletResponse verify(String challenge, String code) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/mfa/verify")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("challenge", challenge, "code", code))))
                .andReturn()
                .getResponse();
    }

    private JsonNode json(MockHttpServletResponse response) throws Exception {
        return objectMapper.readTree(response.getContentAsString(StandardCharsets.UTF_8));
    }

    private String code(JsonNode body) {
        return body.path("error").path("code").asString();
    }

    private void assertRefused(MockHttpServletResponse response, int status, String code) throws Exception {
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(status);
        assertThat(code(json(response))).isEqualTo(code);
    }

    private long count(String sql, Object... args) {
        return jdbcTemplate.queryForObject(sql, Long.class, args);
    }

    // --- The password answers 202 --------------------------------------------------------------------------

    @Test
    void an_enrolled_admins_password_alone_gets_a_challenge_and_no_token_anywhere() throws Exception {
        User admin = admin();
        auth.enroll(admin);

        MockHttpServletResponse response = login(admin.getEmail(), PASSWORD);

        assertThat(response.getStatus()).isEqualTo(202);
        String body = response.getContentAsString();
        assertThat(body)
                .doesNotContain("accessToken")
                .doesNotContain("refreshToken")
                .doesNotContain("Bearer");
        JsonNode data = json(response).path("data");
        assertThat(data.path("purpose").asString()).isEqualTo("VERIFY");
        assertThat(data.path("methods")).extracting(JsonNode::asString).containsExactly("TOTP", "RECOVERY_CODE");
        assertThat(data.path("expiresIn").asInt()).isEqualTo(300);
        assertThat(data.path("enrollmentCodeRequired").asBoolean()).isFalse();
        assertThat(data.path("challenge").asString()).hasSizeGreaterThanOrEqualTo(40);
        // No session was opened by the first factor alone.
        assertThat(count("SELECT count(*) FROM refresh_tokens WHERE user_id = ?", admin.getId()))
                .isZero();
    }

    @Test
    void the_challenge_is_stored_as_a_hash_only() throws Exception {
        User admin = admin();
        auth.enroll(admin);

        String challenge = challengeOf(admin);

        assertThat(count("SELECT count(*) FROM mfa_challenge WHERE token_hash = ?", challenge))
                .as("the raw value is not stored")
                .isZero();
        assertThat(count(
                        "SELECT count(*) FROM mfa_challenge WHERE token_hash = ? AND user_id = ?",
                        RefreshTokenService.hash(challenge),
                        admin.getId()))
                .isEqualTo(1);
    }

    // --- The code answers with the session ------------------------------------------------------------------

    @Test
    void a_valid_code_opens_a_session_that_remembers_both_proofs_and_the_tokens_work() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        String challenge = challengeOf(admin);
        Instant before = Instant.now().minusSeconds(2);

        MockHttpServletResponse response = verify(challenge, mfa.code());

        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
        JsonNode data = json(response).path("data");
        assertThat(data.path("accessToken").asString()).isNotBlank();
        assertThat(data.path("refreshToken").asString()).isNotBlank();
        assertThat(data.path("expiresIn").asInt()).isEqualTo(900);
        assertThat(data.path("recoveryCodesRemaining").asInt()).isEqualTo(10);
        assertThat(data.path("usedRecoveryCode").asBoolean()).isFalse();
        Map<String, Object> row = jdbcTemplate.queryForMap(
                "SELECT mfa_verified_at, authenticated_at FROM refresh_tokens WHERE token_hash = ?",
                RefreshTokenService.hash(data.path("refreshToken").asString()));
        assertThat(((Timestamp) row.get("mfa_verified_at")).toInstant()).isAfter(before);
        assertThat(((Timestamp) row.get("authenticated_at")).toInstant()).isAfter(before);
        mockMvc.perform(get("/api/v1/auth/me")
                        .header(
                                "Authorization",
                                "Bearer " + data.path("accessToken").asString()))
                .andExpect(status().isOk());
    }

    @Test
    void the_code_of_the_previous_step_is_accepted_once_and_the_code_of_the_next_step_is_refused() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);

        assertThat(verify(challengeOf(admin), mfa.codeAtOffset(-1)).getStatus())
                .as("the window is the current step and the one before")
                .isEqualTo(200);

        auth.resetSecondStep(admin.getId());
        assertRefused(verify(challengeOf(admin), mfa.codeAtOffset(1)), 401, "MFA_CODE_INVALID");
    }

    @Test
    void the_same_code_a_second_time_is_refused_and_so_is_an_older_step_after_a_newer_one() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        String used = mfa.code();
        assertThat(verify(challengeOf(admin), used).getStatus()).isEqualTo(200);

        // Replay: the very same code, on a fresh challenge.
        assertRefused(verify(challengeOf(admin), used), 401, "MFA_CODE_INVALID");
        // An older step than the last accepted one is refused too (RFC 6238 5.2): the person waits for the next code.
        assertRefused(verify(challengeOf(admin), mfa.codeAtOffset(-1)), 401, "MFA_CODE_INVALID");
    }

    @Test
    void two_parallel_submissions_of_one_code_open_exactly_one_session() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        String first = challengeOf(admin);
        String second = challengeOf(admin);
        String code = mfa.code();
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            List<Future<MockHttpServletResponse>> results = new ArrayList<>();
            for (String challenge : List.of(first, second)) {
                results.add(pool.submit(() -> {
                    assertThat(start.await(10, TimeUnit.SECONDS)).isTrue();
                    return verify(challenge, code);
                }));
            }
            start.countDown();
            List<Integer> statuses = new ArrayList<>();
            for (Future<MockHttpServletResponse> result : results) {
                statuses.add(result.get(30, TimeUnit.SECONDS).getStatus());
            }
            assertThat(statuses).containsExactlyInAnyOrder(200, 401);
        } finally {
            pool.shutdownNow();
        }
        assertThat(count("SELECT count(*) FROM refresh_tokens WHERE user_id = ?", admin.getId()))
                .isEqualTo(1);
    }

    // --- Recovery codes --------------------------------------------------------------------------------------

    @Test
    void a_recovery_code_works_once_and_the_authenticator_stays_enrolled() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        String recovery = RecoveryCodes.format(mfa.recoveryCodes().getFirst());

        MockHttpServletResponse response = verify(challengeOf(admin), recovery);

        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
        assertThat(json(response).path("data").path("usedRecoveryCode").asBoolean())
                .isTrue();
        assertThat(json(response).path("data").path("recoveryCodesRemaining").asInt())
                .isEqualTo(9);
        // The code is spent.
        assertRefused(verify(challengeOf(admin), recovery), 401, "MFA_CODE_INVALID");
        // The authenticator is still enrolled and still works.
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ? AND status = 'ACTIVE'", admin.getId()))
                .isEqualTo(1);
        assertThat(verify(challengeOf(admin), mfa.code()).getStatus()).isEqualTo(200);
        // A recovery code typed the way it is shown, in lower case and with spaces, works the same way.
        assertThat(verify(challengeOf(admin), mfa.recoveryCodes().get(1).toLowerCase(Locale.ROOT))
                        .getStatus())
                .isEqualTo(200);
    }

    // --- Dead challenges -------------------------------------------------------------------------------------

    @Test
    void unknown_expired_and_consumed_challenges_all_get_the_identical_answer() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        String unknown = verifyBody("no-such-challenge", mfa.code());

        String expired = challengeOf(admin);
        jdbcTemplate.update(
                "UPDATE mfa_challenge SET expires_at = ? WHERE token_hash = ?",
                Timestamp.from(Instant.now().minusSeconds(5)),
                RefreshTokenService.hash(expired));
        String consumed = challengeOf(admin);
        jdbcTemplate.update(
                "UPDATE mfa_challenge SET consumed_at = ? WHERE token_hash = ?",
                Timestamp.from(Instant.now()),
                RefreshTokenService.hash(consumed));

        for (String challenge : List.of(expired, consumed)) {
            MockHttpServletResponse response = verify(challenge, mfa.code());
            assertRefused(response, 401, "MFA_CHALLENGE_INVALID");
            assertThat(withoutTrace(response.getContentAsString())).isEqualTo(unknown);
        }
    }

    private String verifyBody(String challenge, String code) throws Exception {
        MockHttpServletResponse response = verify(challenge, code);
        assertRefused(response, 401, "MFA_CHALLENGE_INVALID");
        return withoutTrace(response.getContentAsString());
    }

    private static String withoutTrace(String body) {
        return body.replaceAll("\"traceId\":\"[^\"]*\"", "\"traceId\":\"-\"");
    }

    @Test
    void five_wrong_codes_end_the_challenge_and_the_person_starts_again_with_the_password() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        String challenge = challengeOf(admin);

        for (int i = 0; i < 5; i++) {
            assertRefused(verify(challenge, wrongCode(mfa)), 401, "MFA_CODE_INVALID");
        }
        // The account's own brake is on too (five in a row); lift it to look at the challenge alone.
        jdbcTemplate.update("UPDATE user_mfa SET locked_until = NULL WHERE user_id = ?", admin.getId());

        assertRefused(verify(challenge, mfa.code()), 401, "MFA_CHALLENGE_INVALID");
        assertThat(count(
                        "SELECT attempts FROM mfa_challenge WHERE token_hash = ?", RefreshTokenService.hash(challenge)))
                .isEqualTo(5);
        // A fresh challenge, after the password again, works.
        auth.resetSecondStep(admin.getId());
        assertThat(verify(challengeOf(admin), mfa.code()).getStatus()).isEqualTo(200);
    }

    @Test
    void a_success_ends_every_other_challenge_of_the_account() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        String winner = challengeOf(admin);
        String other = challengeOf(admin);

        assertThat(verify(winner, mfa.code()).getStatus()).isEqualTo(200);

        auth.resetSecondStep(admin.getId());
        assertRefused(verify(other, mfa.codeAtOffset(-1)), 401, "MFA_CHALLENGE_INVALID");
    }

    @Test
    void a_challenge_created_before_the_cut_off_of_the_account_is_dead() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        String challenge = challengeOf(admin);
        // A password change, a sign-out everywhere, a role change or an operator reset moves the cut-off. The
        // application
        // clock, not the database's: the container's clock is not the machine's.
        Thread.sleep(25);
        jdbcTemplate.update(
                "UPDATE users SET tokens_valid_after = ? WHERE id = ?", Timestamp.from(Instant.now()), admin.getId());
        Thread.sleep(25);

        assertRefused(verify(challenge, mfa.code()), 401, "MFA_CHALLENGE_INVALID");
        // Nothing was evaluated: no failure is counted.
        assertThat(count("SELECT failed_attempts FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isZero();
        // One created after the cut-off works.
        assertThat(verify(challengeOf(admin), mfa.code()).getStatus()).isEqualTo(200);
    }

    @Test
    void a_challenge_of_the_enroll_purpose_is_not_accepted_for_a_code() throws Exception {
        User admin = admin(); // no authenticator: the second step is the enrollment
        MockHttpServletResponse response = login(admin.getEmail(), PASSWORD);
        assertThat(response.getStatus()).isEqualTo(202);
        assertThat(json(response).path("data").path("purpose").asString()).isEqualTo("ENROLL");
        assertThat(json(response).path("data").path("methods"))
                .extracting(JsonNode::asString)
                .containsExactly("TOTP");

        assertRefused(
                verify(json(response).path("data").path("challenge").asString(), "123456"),
                401,
                "MFA_CHALLENGE_INVALID");
    }

    @Test
    void the_21st_live_challenge_is_refused_and_the_oldest_still_works() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        String oldest = challengeOf(admin);
        for (int i = 1; i < 20; i++) {
            challengeOf(admin);
        }

        MockHttpServletResponse refused = login(admin.getEmail(), PASSWORD);

        assertRefused(refused, 429, "MFA_RATE_LIMITED");
        assertThat(count("SELECT count(*) FROM mfa_challenge WHERE user_id = ?", admin.getId()))
                .isEqualTo(20);
        // Evicting the oldest would let someone who holds the password kill the owner's pending challenge.
        assertThat(verify(oldest, mfa.code()).getStatus()).isEqualTo(200);
    }

    // --- The order of the checks -----------------------------------------------------------------------------

    @Test
    void a_suspended_account_is_told_before_any_challenge_exists() throws Exception {
        User admin = admin();
        auth.enroll(admin);
        auth.setStatus(admin.getId(), UserStatus.SUSPENDED);

        assertRefused(login(admin.getEmail(), PASSWORD), 403, "USER_SUSPENDED");

        assertThat(count("SELECT count(*) FROM mfa_challenge WHERE user_id = ?", admin.getId()))
                .isZero();
        // A wrong password is still only a wrong password.
        assertRefused(login(admin.getEmail(), "sai-mat-khau"), 401, "INVALID_CREDENTIALS");
    }

    @Test
    void a_wrong_password_an_unknown_email_and_an_account_without_a_password_are_byte_identical() throws Exception {
        User enrolled = admin();
        auth.enroll(enrolled);
        // A GitHub account that somehow carries an email: no password hash, so it takes the very same path.
        User noPassword = auth.createReader(auth.nextGithubId(), "khong-mat-khau-" + UUID.randomUUID());
        String noPasswordEmail = "khong-mat-khau-" + UUID.randomUUID() + "@blog.local";
        jdbcTemplate.update("UPDATE users SET email = ? WHERE id = ?", noPasswordEmail, noPassword.getId());

        List<String> bodies = new ArrayList<>();
        bodies.add(login(enrolled.getEmail(), "sai-mat-khau").getContentAsString());
        bodies.add(login("khong-ton-tai-" + UUID.randomUUID() + "@blog.local", PASSWORD)
                .getContentAsString());
        bodies.add(login(noPasswordEmail, PASSWORD).getContentAsString());

        List<String> stripped = bodies.stream().map(MfaLoginIT::withoutTrace).toList();
        // The golden answer: it never mentions two-step verification, so nobody without the password can tell an
        // enrolled account from any other.
        assertThat(stripped)
                .containsOnly(
                        "{\"error\":{\"code\":\"INVALID_CREDENTIALS\",\"message\":\"Email or password is incorrect\",\"traceId\":\"-\"}}");
        assertThat(count("SELECT count(*) FROM mfa_challenge WHERE user_id = ?", enrolled.getId()))
                .isZero();
    }

    // --- What counts as a wrong code -------------------------------------------------------------------------

    @Test
    void a_malformed_code_is_a_wrong_code_and_counts_like_one() throws Exception {
        User admin = admin();
        auth.enroll(admin);
        String challenge = challengeOf(admin);

        for (String malformed : List.of("12345", "1234567", "abcdef", "ABCD-EFGH", "x")) {
            assertRefused(verify(challenge, malformed), 401, "MFA_CODE_INVALID");
            jdbcTemplate.update("UPDATE user_mfa SET locked_until = NULL WHERE user_id = ?", admin.getId());
        }

        assertThat(count("SELECT failed_attempts FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isEqualTo(5);
        assertThat(count(
                        "SELECT attempts FROM mfa_challenge WHERE token_hash = ?", RefreshTokenService.hash(challenge)))
                .isEqualTo(5);
    }

    @Test
    void a_request_without_a_challenge_or_a_code_is_a_validation_error_not_a_server_error() throws Exception {
        for (String body :
                List.of("{}", "{\"challenge\":\"x\"}", "{\"code\":\"123456\"}", "{\"challenge\":\"\",\"code\":\"\"}")) {
            MockHttpServletResponse response = mockMvc.perform(post("/api/v1/auth/mfa/verify")
                            .contentType(APPLICATION_JSON)
                            .content(body))
                    .andReturn()
                    .getResponse();
            assertRefused(response, 400, "VALIDATION_ERROR");
        }
    }

    /** A six-digit code that is not valid in the current window. */
    private static String wrongCode(EnrolledAccount mfa) {
        List<String> valid = List.of(mfa.code(), mfa.codeAtOffset(-1));
        for (String candidate : List.of("000000", "111111", "222222")) {
            if (!valid.contains(candidate)) {
                return candidate;
            }
        }
        throw new IllegalStateException("unreachable");
    }
}
