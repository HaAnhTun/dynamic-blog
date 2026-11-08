package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.auth.mfa.MfaSecrets;
import com.blog.auth.mfa.RecoveryCodes;
import com.blog.auth.mfa.Totp;
import com.blog.auth.service.RefreshTokenService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
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
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * The forced enrollment of an administrator over HTTP, in the shared development context (the enrollment window is open
 * there: ProductionMode is inactive, which is what lets a throw-away E2E stack enrol without ceremony). The production
 * window, the operator's enrollment code and the setup-hour window are in the ITs of the {@code setup} package, whose
 * contexts are production runs.
 *
 * Every test uses an ADMIN account of its own, so the shared seeded admin keeps its state for the other test classes.
 */
@AutoConfigureMockMvc
class MfaEnrollmentIT extends AbstractIntegrationTest {

    private static final String PASSWORD = "mat-khau-cua-quan-tri-dang-ky";

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
        User admin = auth.createAccount("mfa-enroll-" + UUID.randomUUID() + "@blog.local", UserRole.ADMIN);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?", passwordEncoder.encode(PASSWORD), admin.getId());
        return admin;
    }

    private MockHttpServletResponse call(String path, Map<String, String> body) throws Exception {
        return mockMvc.perform(post(path).contentType(APPLICATION_JSON).content(objectMapper.writeValueAsString(body)))
                .andReturn()
                .getResponse();
    }

    private JsonNode json(MockHttpServletResponse response) throws Exception {
        return objectMapper.readTree(response.getContentAsString(StandardCharsets.UTF_8));
    }

    private String enrollChallenge(User admin) throws Exception {
        MockHttpServletResponse login =
                call("/api/v1/auth/login", Map.of("email", admin.getEmail(), "password", PASSWORD));
        assertThat(login.getStatus()).as(login.getContentAsString()).isEqualTo(202);
        assertThat(json(login).path("data").path("purpose").asString()).isEqualTo("ENROLL");
        return json(login).path("data").path("challenge").asString();
    }

    private JsonNode begin(String challenge) throws Exception {
        MockHttpServletResponse response = call("/api/v1/auth/mfa/enroll/begin", Map.of("challenge", challenge));
        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
        return json(response).path("data");
    }

    private MockHttpServletResponse confirm(String challenge, String code) throws Exception {
        return call("/api/v1/auth/mfa/enroll/confirm", Map.of("challenge", challenge, "code", code));
    }

    private static String codeOf(JsonNode secret, int stepOffset) {
        byte[] bytes = MfaSecrets.decode(secret.path("secretBase32").asString()).orElseThrow();
        return Totp.code(bytes, Totp.stepOf(Instant.now()) + stepOffset);
    }

    private long count(String sql, Object... args) {
        return jdbcTemplate.queryForObject(sql, Long.class, args);
    }

    private String errorCode(MockHttpServletResponse response) throws Exception {
        return json(response).path("error").path("code").asString();
    }

    // --- Begin ---------------------------------------------------------------------------------------------------

    @Test
    void begin_answers_the_secret_and_the_link_for_an_app_and_stores_only_a_pending_enrollment() throws Exception {
        User admin = admin();
        String challenge = enrollChallenge(admin);

        JsonNode secret = begin(challenge);

        assertThat(secret.path("secretBase32").asString()).matches("[A-Z2-7]{32}");
        assertThat(secret.path("issuer").asString()).isEqualTo("Blog");
        assertThat(secret.path("account").asString()).isEqualTo(admin.getEmail());
        String link = secret.path("otpauthUri").asString();
        assertThat(link)
                .startsWith("otpauth://totp/Blog:")
                .contains("secret=" + secret.path("secretBase32").asString())
                .contains("&issuer=Blog&algorithm=SHA1&digits=6&period=30")
                .contains(admin.getEmail().replace("@", "%40"));
        // Nothing else about the account changed: a PENDING row, no recovery codes, no session.
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ? AND status = 'PENDING'", admin.getId()))
                .isEqualTo(1);
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ? AND status = 'ACTIVE'", admin.getId()))
                .isZero();
        assertThat(count("SELECT count(*) FROM user_mfa_recovery_code WHERE user_id = ?", admin.getId()))
                .isZero();
        assertThat(count("SELECT count(*) FROM refresh_tokens WHERE user_id = ?", admin.getId()))
                .isZero();
    }

    @Test
    void a_second_begin_overwrites_the_pending_secret() throws Exception {
        User admin = admin();
        String challenge = enrollChallenge(admin);
        JsonNode first = begin(challenge);
        JsonNode second = begin(challenge);

        assertThat(second.path("secretBase32").asString())
                .isNotEqualTo(first.path("secretBase32").asString());
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isEqualTo(1);
        // Only the newest secret confirms.
        assertThat(confirm(challenge, codeOf(first, 0)).getStatus()).isEqualTo(401);
        jdbcTemplate.update(
                "UPDATE user_mfa SET locked_until = NULL, failed_attempts = 0 WHERE user_id = ?", admin.getId());
        assertThat(confirm(challenge, codeOf(second, 0)).getStatus()).isEqualTo(200);
    }

    @Test
    void the_enrollment_code_is_not_asked_while_the_window_is_open() throws Exception {
        User admin = admin();
        MockHttpServletResponse login =
                call("/api/v1/auth/login", Map.of("email", admin.getEmail(), "password", PASSWORD));

        assertThat(json(login).path("data").path("enrollmentCodeRequired").asBoolean())
                .isFalse();
    }

    @Test
    void begin_with_a_challenge_that_is_not_for_enrollment_or_is_unknown_gets_the_one_challenge_answer()
            throws Exception {
        User admin = admin();
        auth.enroll(admin);
        MockHttpServletResponse login =
                call("/api/v1/auth/login", Map.of("email", admin.getEmail(), "password", PASSWORD));
        String verifyChallenge = json(login).path("data").path("challenge").asString();

        for (String challenge : List.of(verifyChallenge, "khong-ton-tai")) {
            MockHttpServletResponse response = call("/api/v1/auth/mfa/enroll/begin", Map.of("challenge", challenge));
            assertThat(response.getStatus()).isEqualTo(401);
            assertThat(errorCode(response)).isEqualTo("MFA_CHALLENGE_INVALID");
        }
    }

    @Test
    void begin_against_an_account_that_became_enrolled_in_the_meantime_is_a_stale_challenge() throws Exception {
        User admin = admin();
        String challenge = enrollChallenge(admin);
        auth.enroll(admin); // another tab finished the enrollment

        MockHttpServletResponse response = call("/api/v1/auth/mfa/enroll/begin", Map.of("challenge", challenge));

        assertThat(response.getStatus()).isEqualTo(401);
        assertThat(errorCode(response)).isEqualTo("MFA_CHALLENGE_INVALID");
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ? AND status = 'PENDING'", admin.getId()))
                .isZero();
    }

    // --- Confirm -------------------------------------------------------------------------------------------------

    @Test
    void confirm_with_a_wrong_code_keeps_the_enrollment_pending_and_counts() throws Exception {
        User admin = admin();
        String challenge = enrollChallenge(admin);
        JsonNode secret = begin(challenge);
        String right = codeOf(secret, 0);
        String wrong = "000000".equals(right) ? "111111" : "000000";

        MockHttpServletResponse response = confirm(challenge, wrong);

        assertThat(response.getStatus()).isEqualTo(401);
        assertThat(errorCode(response)).isEqualTo("MFA_CODE_INVALID");
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ? AND status = 'PENDING'", admin.getId()))
                .isEqualTo(1);
        assertThat(count("SELECT failed_attempts FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isEqualTo(1);
    }

    @Test
    void confirm_activates_writes_ten_recovery_codes_once_and_revokes_every_older_session() throws Exception {
        User admin = admin();
        // Sessions that existed before the enrollment, signed in or not: a stolen cookie must not survive it.
        String older = auth.unverifiedSession(admin).refreshToken();
        String olderAccess = auth.verifiedSession(admin).accessToken();
        String challenge = enrollChallenge(admin);
        JsonNode secret = begin(challenge);

        MockHttpServletResponse response = confirm(challenge, codeOf(secret, 0));

        assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
        JsonNode data = json(response).path("data");
        assertThat(data.path("accessToken").asString()).isNotBlank();
        assertThat(data.path("expiresIn").asInt()).isEqualTo(900);
        List<String> shown = new ArrayList<>();
        data.path("recoveryCodes").forEach(code -> shown.add(code.asString()));
        assertThat(shown).hasSize(10).doesNotHaveDuplicates();
        assertThat(shown).allMatch(code -> code.matches("[0-9A-Z]{4}(-[0-9A-Z]{4}){5}"));

        // ACTIVE, with the first code's step consumed.
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ? AND status = 'ACTIVE'", admin.getId()))
                .isEqualTo(1);
        assertThat(count("SELECT last_used_step FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isPositive();
        // The recovery codes are stored as hashes only.
        List<String> stored = jdbcTemplate.queryForList(
                "SELECT code_hash FROM user_mfa_recovery_code WHERE user_id = ?", String.class, admin.getId());
        assertThat(stored).hasSize(10);
        for (String code : shown) {
            assertThat(stored)
                    .contains(RecoveryCodes.hash(RecoveryCodes.normalise(code)))
                    .doesNotContain(code);
        }
        // The new session carries the proof; every older one is gone.
        assertThat(count(
                        "SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL AND mfa_verified_at IS NOT NULL",
                        admin.getId()))
                .isEqualTo(1);
        assertThat(count("SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL", admin.getId()))
                .isEqualTo(1);
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT revoked_at IS NOT NULL FROM refresh_tokens WHERE token_hash = ?",
                        Boolean.class,
                        RefreshTokenService.hash(older)))
                .isTrue();
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT tokens_valid_after IS NOT NULL FROM users WHERE id = ?", Boolean.class, admin.getId()))
                .isTrue();
        // The access token of an older session stops working at once (its session is gone, the cut-off moved).
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + olderAccess))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void the_challenge_works_once_and_the_account_signs_in_with_the_new_authenticator_afterwards() throws Exception {
        User admin = admin();
        String challenge = enrollChallenge(admin);
        JsonNode secret = begin(challenge);
        assertThat(confirm(challenge, codeOf(secret, 0)).getStatus()).isEqualTo(200);

        // The challenge is spent: a second confirm, a second begin.
        assertThat(errorCode(confirm(challenge, codeOf(secret, 0)))).isEqualTo("MFA_CHALLENGE_INVALID");
        assertThat(errorCode(call("/api/v1/auth/mfa/enroll/begin", Map.of("challenge", challenge))))
                .isEqualTo("MFA_CHALLENGE_INVALID");

        // The next sign-in is a VERIFY challenge, and the secret the person scanned opens it.
        MockHttpServletResponse login =
                call("/api/v1/auth/login", Map.of("email", admin.getEmail(), "password", PASSWORD));
        assertThat(login.getStatus()).isEqualTo(202);
        assertThat(json(login).path("data").path("purpose").asString()).isEqualTo("VERIFY");
        // The code of the step after the one consumed at confirm: a code is never accepted twice.
        jdbcTemplate.update("UPDATE user_mfa SET last_used_step = 0 WHERE user_id = ?", admin.getId());
        MockHttpServletResponse verified = call(
                "/api/v1/auth/mfa/verify",
                Map.of("challenge", json(login).path("data").path("challenge").asString(), "code", codeOf(secret, 0)));
        assertThat(verified.getStatus()).as(verified.getContentAsString()).isEqualTo(200);
    }

    @Test
    void an_abandoned_enrollment_leaves_the_account_as_it_was_and_the_next_sign_in_enrols_again() throws Exception {
        User admin = admin();
        String challenge = enrollChallenge(admin);
        begin(challenge); // the tab is closed, the phone is lost

        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ? AND status = 'ACTIVE'", admin.getId()))
                .isZero();
        assertThat(count("SELECT count(*) FROM refresh_tokens WHERE user_id = ?", admin.getId()))
                .isZero();
        // Still an enrollment, not a code prompt: nobody is locked out.
        assertThat(enrollChallenge(admin)).isNotEqualTo(challenge);
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isEqualTo(1);
    }

    @Test
    void an_enrollment_challenge_of_an_older_sign_in_cannot_be_confirmed_after_the_cut_off_moved() throws Exception {
        User admin = admin();
        String challenge = enrollChallenge(admin);
        JsonNode secret = begin(challenge);
        jdbcTemplate.update(
                "UPDATE users SET tokens_valid_after = ? WHERE id = ?",
                java.sql.Timestamp.from(Instant.now().plusMillis(50)),
                admin.getId());

        MockHttpServletResponse response = confirm(challenge, codeOf(secret, 0));

        assertThat(response.getStatus()).isEqualTo(401);
        assertThat(errorCode(response)).isEqualTo("MFA_CHALLENGE_INVALID");
        assertThat(errorCode(call("/api/v1/auth/mfa/enroll/begin", Map.of("challenge", challenge))))
                .isEqualTo("MFA_CHALLENGE_INVALID");
    }
}
