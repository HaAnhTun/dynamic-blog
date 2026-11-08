package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import ch.qos.logback.classic.Level;
import com.blog.auth.service.MfaVerifier;
import com.blog.auth.service.RefreshTokenService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.AuthTestSupport.EnrolledAccount;
import com.blog.support.HeldTransaction;
import com.blog.support.LogCapture;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
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
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Reserve-then-verify under load. The guarantee that matters is the one keyed by the account (the per-IP counters of Next
 * can be bypassed, audit 004 and 017): however many challenges and parallel requests an attacker who holds the password
 * uses, five codes are evaluated before the delay starts, and after 100 in a row the second step is frozen.
 */
@AutoConfigureMockMvc
class MfaConcurrencyIT extends AbstractIntegrationTest {

    private static final String PASSWORD = "mat-khau-thu-nghiem-dong-thoi";

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

    private User admin() {
        User admin = auth.createAccount("mfa-load-" + UUID.randomUUID() + "@blog.local", UserRole.ADMIN);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?", passwordEncoder.encode(PASSWORD), admin.getId());
        return admin;
    }

    private String challengeOf(User account) throws Exception {
        MockHttpServletResponse response = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("email", account.getEmail(), "password", PASSWORD))))
                .andReturn()
                .getResponse();
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(202);
        return objectMapper
                .readTree(response.getContentAsString(StandardCharsets.UTF_8))
                .path("data")
                .path("challenge")
                .asString();
    }

    private MockHttpServletResponse verify(String challenge, String code) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/mfa/verify")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("challenge", challenge, "code", code))))
                .andReturn()
                .getResponse();
    }

    private String errorCode(MockHttpServletResponse response) throws Exception {
        JsonNode body = objectMapper.readTree(response.getContentAsString(StandardCharsets.UTF_8));
        return body.path("error").path("code").asString();
    }

    private long count(String sql, Object... args) {
        return jdbcTemplate.queryForObject(sql, Long.class, args);
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

    /** Releases all requests at once and returns the outcome of each as {@code status/CODE}. */
    private List<String> burst(List<String[]> requests) throws Exception {
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(requests.size());
        try {
            List<Future<String>> results = new ArrayList<>();
            for (String[] request : requests) {
                results.add(pool.submit(() -> {
                    assertThat(start.await(15, TimeUnit.SECONDS)).isTrue();
                    MockHttpServletResponse response = verify(request[0], request[1]);
                    return response.getStatus() == 200 ? "200" : response.getStatus() + "/" + errorCode(response);
                }));
            }
            start.countDown();
            List<String> outcomes = new ArrayList<>();
            for (Future<String> result : results) {
                outcomes.add(result.get(60, TimeUnit.SECONDS));
            }
            return outcomes;
        } finally {
            pool.shutdownNow();
        }
    }

    private static Map<String, Long> tally(List<String> outcomes) {
        Map<String, Long> tally = new HashMap<>();
        outcomes.forEach(outcome -> tally.merge(outcome, 1L, Long::sum));
        return tally;
    }

    // --- (a) fifty wrong codes over ten challenges ---------------------------------------------------------

    @Test
    void fifty_parallel_wrong_codes_over_ten_challenges_are_evaluated_exactly_five_times_before_the_lock()
            throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        List<String> challenges = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            challenges.add(challengeOf(admin));
        }
        String wrong = wrongCode(mfa);
        List<String[]> requests = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            requests.add(new String[] {challenges.get(i % 10), wrong});
        }

        Map<String, Long> tally = tally(burst(requests));

        assertThat(tally).containsEntry("401/MFA_CODE_INVALID", 5L).containsEntry("429/MFA_RATE_LIMITED", 45L);
        assertThat(tally).hasSize(2);
        // The counters agree: five evaluations, five reserved attempts, the lock is running.
        assertThat(count("SELECT failed_attempts FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isEqualTo(5);
        assertThat(count("SELECT COALESCE(sum(attempts), 0) FROM mfa_challenge WHERE user_id = ?", admin.getId()))
                .isEqualTo(5);
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT locked_until > now() FROM user_mfa WHERE user_id = ?", Boolean.class, admin.getId()))
                .isTrue();
    }

    // --- (b) the correct code is refused while the lock runs ------------------------------------------------

    @Test
    void after_the_lock_engages_a_burst_of_wrong_codes_and_the_correct_one_is_refused_in_full() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        String first = challengeOf(admin);
        List<String> spare = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            spare.add(challengeOf(admin));
        }
        String wrong = wrongCode(mfa);
        for (int i = 0; i < 5; i++) {
            assertThat(verify(first, wrong).getStatus()).isEqualTo(401);
        }
        assertThat(count("SELECT failed_attempts FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isEqualTo(5);

        List<String[]> requests = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            requests.add(new String[] {spare.get(i % 10), wrong});
        }
        requests.add(new String[] {spare.getFirst(), mfa.code()});
        Map<String, Long> tally = tally(burst(requests));

        // Every one of the 51 is refused with 429 and evaluated by nobody: the delay is a brake, so even the right code
        // waits for it.
        assertThat(tally).containsOnlyKeys("429/MFA_RATE_LIMITED").containsEntry("429/MFA_RATE_LIMITED", 51L);
        assertThat(count("SELECT failed_attempts FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isEqualTo(5);
        assertThat(count("SELECT COALESCE(sum(attempts), 0) FROM mfa_challenge WHERE user_id = ?", admin.getId()))
                .isEqualTo(5);
        assertThat(count("SELECT count(*) FROM refresh_tokens WHERE user_id = ?", admin.getId()))
                .isZero();
    }

    // --- (c) the ceiling --------------------------------------------------------------------------------------

    @Test
    void a_hundred_consecutive_failures_freeze_the_second_step_even_for_the_correct_code() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        String wrong = wrongCode(mfa);
        List<String> challenges = new ArrayList<>();
        for (int i = 0; i < 20; i++) {
            challenges.add(challengeOf(admin));
        }

        try (LogCapture logs = LogCapture.of(MfaVerifier.class)) {
            for (String challenge : challenges) {
                for (int attempt = 0; attempt < 5; attempt++) {
                    // The delays are real time, so the test rewinds the lock between rounds; the counter is untouched.
                    jdbcTemplate.update("UPDATE user_mfa SET locked_until = NULL WHERE user_id = ?", admin.getId());
                    assertThat(verify(challenge, wrong).getStatus()).isEqualTo(401);
                }
            }
            assertThat(count("SELECT failed_attempts FROM user_mfa WHERE user_id = ?", admin.getId()))
                    .isEqualTo(100);
            // The operator hears about it once, at the moment the counter reaches 100.
            assertThat(logs.messages(Level.ERROR))
                    .hasSize(1)
                    .singleElement()
                    .asString()
                    .startsWith("mfa second step frozen userId=" + admin.getId());

            String fresh = challengeOf(admin);
            jdbcTemplate.update("UPDATE user_mfa SET locked_until = NULL WHERE user_id = ?", admin.getId());
            MockHttpServletResponse frozen = verify(fresh, mfa.code());

            assertThat(frozen.getStatus()).isEqualTo(403);
            assertThat(errorCode(frozen)).isEqualTo("MFA_FROZEN");
            assertThat(verify(fresh, wrong).getStatus()).isEqualTo(403);
            assertThat(count("SELECT failed_attempts FROM user_mfa WHERE user_id = ?", admin.getId()))
                    .as("a frozen second step evaluates nothing and counts nothing")
                    .isEqualTo(100);
            assertThat(logs.messages(Level.ERROR)).as("not logged again").hasSize(1);
        }
    }

    // --- The lock timeout ------------------------------------------------------------------------------------

    @Test
    void a_second_step_that_cannot_get_the_account_lock_in_two_seconds_answers_429_and_evaluates_nothing()
            throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        String challenge = challengeOf(admin);

        try (HeldTransaction held = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForList(
                        "SELECT user_id FROM user_mfa WHERE user_id = ? FOR UPDATE", UUID.class, admin.getId()))) {
            MockHttpServletResponse busy = verify(challenge, mfa.code());

            assertThat(busy.getStatus()).as(busy.getContentAsString()).isEqualTo(429);
            assertThat(errorCode(busy)).isEqualTo("MFA_RATE_LIMITED");
            held.commit();
        }

        // Nothing was evaluated, reserved or counted, so the same challenge and code work now.
        assertThat(count("SELECT failed_attempts FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isZero();
        assertThat(count(
                        "SELECT attempts FROM mfa_challenge WHERE token_hash = ?", RefreshTokenService.hash(challenge)))
                .isZero();
        assertThat(verify(challenge, mfa.code()).getStatus()).isEqualTo(200);
    }
}
