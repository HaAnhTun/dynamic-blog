package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import ch.qos.logback.classic.Level;
import com.blog.auth.mfa.RecoveryCodes;
import com.blog.auth.service.AuthService;
import com.blog.auth.service.MfaChallengeService;
import com.blog.auth.service.MfaService;
import com.blog.auth.service.MfaVerifier;
import com.blog.auth.service.RefreshTokenService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.AuthTestSupport.EnrolledAccount;
import com.blog.support.LogCapture;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.nio.charset.StandardCharsets;
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
import tools.jackson.databind.ObjectMapper;

/**
 * The audit trail of the second step (docs/SECURITY.md, "Audit events"): one greppable line per event with the user id and a
 * coarse reason, and nothing sensitive in any of them. The vocabulary is part of the contract with the operator.
 */
@AutoConfigureMockMvc
class MfaLoggingIT extends AbstractIntegrationTest {

    private static final String PASSWORD = "mat-khau-nhat-ky-kiem-toan";

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
        User admin = auth.createAccount("mfa-log-" + UUID.randomUUID() + "@blog.local", UserRole.ADMIN);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?", passwordEncoder.encode(PASSWORD), admin.getId());
        return admin;
    }

    private MockHttpServletResponse login(User account, String password) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("email", account.getEmail(), "password", password))))
                .andReturn()
                .getResponse();
    }

    private String challengeOf(User account) throws Exception {
        MockHttpServletResponse response = login(account, PASSWORD);
        assertThat(response.getStatus()).isEqualTo(202);
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

    private static LogCapture capture() {
        return LogCapture.of(
                AuthService.class,
                MfaService.class,
                MfaVerifier.class,
                MfaChallengeService.class,
                RefreshTokenService.class);
    }

    @Test
    void every_event_of_a_sign_in_writes_its_line_and_none_carries_a_secret() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        String id = admin.getId().toString();
        String recovery = mfa.recoveryCodes().getFirst();

        try (LogCapture logs = capture()) {
            // A wrong password: a coarse reason, no address.
            login(admin, "sai-mat-khau-hoan-toan");
            // The right password: a challenge.
            String challenge = challengeOf(admin);
            // A wrong code, then the right one, then the same one again (a replay), then a recovery code.
            String wrong = "000000".equals(mfa.code()) ? "111111" : "000000";
            verify(challenge, wrong);
            auth.resetSecondStep(admin.getId());
            String code = mfa.code();
            assertThat(verify(challenge, code).getStatus()).isEqualTo(200);
            String second = challengeOf(admin);
            verify(second, code);
            auth.resetSecondStep(admin.getId());
            verify(challengeOf(admin), RecoveryCodes.format(recovery));
            // A challenge nobody knows.
            verify("khong-ton-tai", code);

            List<String> messages = logs.messages();
            assertThat(messages).contains("password login failed reason=bad_password");
            assertThat(messages).contains("password login ok userId=" + id);
            assertThat(messages).contains("mfa challenge issued userId=" + id + " purpose=VERIFY firstFactor=PASSWORD");
            assertThat(messages).contains("mfa verify failed userId=" + id + " reason=bad_code");
            assertThat(messages).contains("mfa verify ok userId=" + id + " method=totp recoveryLeft=10");
            assertThat(messages).contains("mfa verify failed userId=" + id + " reason=replay");
            assertThat(messages).contains("mfa verify ok userId=" + id + " method=recovery recoveryLeft=9");
            assertThat(messages).contains("mfa challenge rejected reason=unknown_or_expired");

            // Nothing sensitive, in any line, from the whole flow.
            logs.assertNeverLogged(
                    PASSWORD,
                    "sai-mat-khau-hoan-toan",
                    admin.getEmail(),
                    challenge,
                    second,
                    code,
                    wrong,
                    recovery,
                    RecoveryCodes.format(recovery),
                    mfa.base32());
            for (String message : messages) {
                assertThat(message).doesNotContain("otpauth").doesNotContain("secret=");
            }
        }
    }

    @Test
    void a_lock_a_used_up_challenge_and_a_code_outside_the_window_each_have_their_line() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        String id = admin.getId().toString();
        String wrong = "000000".equals(mfa.code()) ? "111111" : "000000";

        try (LogCapture logs = capture()) {
            String challenge = challengeOf(admin);
            for (int i = 0; i < 5; i++) {
                verify(challenge, wrong);
            }
            // The fifth wrong code started the delay: the next attempt, on another challenge, is not evaluated.
            assertThat(verify(challengeOf(admin), mfa.code()).getStatus()).isEqualTo(429);
            assertThat(logs.messages()).contains("mfa verify failed userId=" + id + " reason=locked");

            // The fifth wrong code also consumed the challenge: it is simply gone for the next attempt.
            jdbcTemplate.update("UPDATE user_mfa SET locked_until = NULL WHERE user_id = ?", admin.getId());
            assertThat(verify(challenge, mfa.code()).getStatus()).isEqualTo(401);
            assertThat(logs.messages()).contains("mfa challenge rejected reason=unknown_or_expired");

            // A challenge whose last attempt is used up but that nobody has consumed yet (two requests racing for the
            // fifth attempt): the line says so.
            String raced = challengeOf(admin);
            jdbcTemplate.update(
                    "UPDATE mfa_challenge SET attempts = 5 WHERE token_hash = ?", RefreshTokenService.hash(raced));
            assertThat(verify(raced, mfa.code()).getStatus()).isEqualTo(401);
            assertThat(logs.messages()).contains("mfa verify failed userId=" + id + " reason=challenge_exhausted");

            // A code from five steps away: refused, and the operator is told the clock is off, with the offset only.
            auth.resetSecondStep(admin.getId());
            String skewed = mfa.codeAtOffset(5);
            verify(challengeOf(admin), skewed);
            assertThat(logs.messages()).contains("mfa code matched outside window userId=" + id + " offsetSteps=5");
            logs.assertNeverLogged(skewed, challenge);
        }
    }

    @Test
    void an_unreadable_secret_is_logged_once_per_attempt_as_an_error_and_answers_like_a_wrong_code() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        // The ciphertext of another key: what a restored dump without MFA_ENCRYPTION_KEY looks like.
        jdbcTemplate.update("UPDATE user_mfa SET key_id = key_id + 1 WHERE user_id = ?", admin.getId());
        String challenge = challengeOf(admin);

        try (LogCapture logs = capture()) {
            MockHttpServletResponse response = verify(challenge, mfa.code());

            assertThat(response.getStatus()).isEqualTo(401);
            assertThat(response.getContentAsString()).contains("MFA_CODE_INVALID");
            assertThat(logs.messages(Level.ERROR)).containsExactly("mfa secret undecryptable userId=" + admin.getId());
            logs.assertNeverLogged(mfa.code(), mfa.base32());
        }
    }

    @Test
    void the_refusal_of_an_unverified_session_at_refresh_is_logged_with_the_user_id_only() throws Exception {
        User admin = admin();
        var session = auth.unverifiedSession(admin);

        try (LogCapture logs = capture()) {
            mockMvc.perform(post("/api/v1/auth/refresh")
                            .contentType(APPLICATION_JSON)
                            .content(objectMapper.writeValueAsString(Map.of("refreshToken", session.refreshToken()))))
                    .andReturn();

            assertThat(logs.messages()).containsExactly("mfa session refused at refresh userId=" + admin.getId());
            logs.assertNeverLogged(session.refreshToken(), session.accessToken());
        }
    }

    @Test
    void the_other_refresh_refusals_name_only_a_reason() throws Exception {
        try (LogCapture logs = capture()) {
            mockMvc.perform(post("/api/v1/auth/refresh")
                            .contentType(APPLICATION_JSON)
                            .content("{\"refreshToken\":\"khong-ton-tai\"}"))
                    .andReturn();

            assertThat(logs.messages()).containsExactly("refresh refused reason=invalid");
            logs.assertNeverLogged("khong-ton-tai");
        }
    }
}
