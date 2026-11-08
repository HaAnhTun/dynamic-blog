package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import ch.qos.logback.classic.Level;
import com.blog.auth.dto.TokenResponse;
import com.blog.auth.mfa.MfaProperties;
import com.blog.auth.service.MfaEnrollmentCodeRunner;
import com.blog.auth.service.MfaOperatorReset;
import com.blog.auth.service.MfaResetState;
import com.blog.auth.service.MfaService;
import com.blog.auth.service.RefreshTokenService;
import com.blog.common.security.AdminGithubLink;
import com.blog.common.security.AdminPasswordFromEnvironment;
import com.blog.common.security.AdminSeedEmail;
import com.blog.setup.service.SetupCompletionFromEnvironment;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.AuthTestSupport.EnrolledAccount;
import com.blog.support.LogCapture;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.ObjectMapper;

/**
 * The operator's reset of one account's second step at startup (lost phone and lost recovery codes). The runner is built by
 * hand so each case chooses the variables; it is the same class the application starts. It acts once per distinct token, in
 * the same transaction as the marker, and never logs the email or the token.
 */
@AutoConfigureMockMvc
class MfaOperatorResetIT extends AbstractIntegrationTest {

    private static final String PASSWORD = "mat-khau-dat-lai-cua-nha-van-hanh";
    private static final String TOKEN_ONE = "dat-lai-lan-mot-0123456789abcdefghij";
    private static final String TOKEN_TWO = "dat-lai-lan-hai-0123456789abcdefghij";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private MfaProperties properties;

    @Autowired
    private MfaResetState state;

    @Autowired
    private MfaService mfaService;

    @Autowired
    private RefreshTokenService refreshTokenService;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private AuthTestSupport auth;

    /** The marker is one row of the whole application: put it back so the other cases and classes start clean. */
    @AfterEach
    void clearMarker() {
        jdbcTemplate.update("UPDATE app_settings SET mfa_reset_applied_hash = NULL WHERE id = 1");
    }

    private User admin() {
        User admin = auth.createAccount("dat-lai-van-hanh-" + UUID.randomUUID() + "@blog.local", UserRole.ADMIN);
        jdbcTemplate.update(
                "UPDATE users SET password_hash = ? WHERE id = ?", passwordEncoder.encode(PASSWORD), admin.getId());
        return admin;
    }

    private MfaOperatorReset runner(String email, String token) {
        MfaProperties configured = new MfaProperties(
                properties.encryptionKey(),
                properties.issuer(),
                properties.challengeTtl(),
                properties.reauthWindow(),
                null,
                email,
                token);
        return new MfaOperatorReset(
                configured, jdbcTemplate, state, mfaService, refreshTokenService, transactionManager);
    }

    private void run(String email, String token) {
        runner(email, token).run(new DefaultApplicationArguments());
    }

    private long count(String sql, Object... args) {
        return jdbcTemplate.queryForObject(sql, Long.class, args);
    }

    private String appliedHash() {
        return jdbcTemplate.queryForObject(
                "SELECT mfa_reset_applied_hash FROM app_settings WHERE id = 1", String.class);
    }

    @Test
    void the_reset_deletes_the_enrollment_ends_every_session_and_every_pending_sign_in() throws Exception {
        User admin = admin();
        EnrolledAccount mfa = auth.enroll(admin);
        TokenResponse session = auth.verifiedSession(admin);
        // Someone who learned the password has a sign-in waiting for its code.
        String challenge = objectMapper
                .readTree(mockMvc.perform(post("/api/v1/auth/login")
                                .contentType(APPLICATION_JSON)
                                .content(objectMapper.writeValueAsString(
                                        Map.of("email", admin.getEmail(), "password", PASSWORD))))
                        .andReturn()
                        .getResponse()
                        .getContentAsString())
                .path("data")
                .path("challenge")
                .asString();

        try (LogCapture logs = LogCapture.of(MfaOperatorReset.class, MfaService.class)) {
            run(admin.getEmail().toUpperCase(java.util.Locale.ROOT), TOKEN_ONE);

            assertThat(logs.messages(Level.WARN))
                    .anyMatch(line ->
                            line.startsWith("mfa operator reset userId=" + admin.getId() + " sessionsRevoked="));
            assertThat(logs.messages()).contains("mfa enrollment removed userId=" + admin.getId() + " by=operator");
            // The email was only looked up; the token is a secret.
            logs.assertNeverLogged(admin.getEmail(), TOKEN_ONE, mfa.base32());
        }

        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isZero();
        assertThat(count("SELECT count(*) FROM user_mfa_recovery_code WHERE user_id = ?", admin.getId()))
                .isZero();
        assertThat(count("SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL", admin.getId()))
                .isZero();
        assertThat(mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + session.accessToken()))
                        .andReturn()
                        .getResponse()
                        .getStatus())
                .isEqualTo(401);
        // The pending challenge is dead: its code can no longer finish the sign-in.
        MockHttpServletResponse late = mockMvc.perform(post("/api/v1/auth/mfa/verify")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(Map.of("challenge", challenge, "code", mfa.code()))))
                .andReturn()
                .getResponse();
        assertThat(late.getStatus()).isEqualTo(401);
        assertThat(late.getContentAsString(StandardCharsets.UTF_8)).contains("MFA_CHALLENGE_INVALID");
        // The next sign-in is an enrollment.
        MockHttpServletResponse next = mockMvc.perform(post("/api/v1/auth/login")
                        .contentType(APPLICATION_JSON)
                        .content(objectMapper.writeValueAsString(
                                Map.of("email", admin.getEmail(), "password", PASSWORD))))
                .andReturn()
                .getResponse();
        assertThat(objectMapper
                        .readTree(next.getContentAsString(StandardCharsets.UTF_8))
                        .path("data")
                        .path("purpose")
                        .asString())
                .isEqualTo("ENROLL");
    }

    @Test
    void it_acts_once_per_distinct_token_hash_and_a_new_token_applies_again() {
        User admin = admin();
        auth.enroll(admin);

        run(admin.getEmail(), TOKEN_ONE);

        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isZero();
        assertThat(appliedHash()).isEqualTo(RefreshTokenService.hash(TOKEN_ONE)).hasSize(64);
        assertThat(appliedHash()).as("never the token itself").doesNotContain(TOKEN_ONE);

        // The variable is forgotten in .env; the person enrols again; the next start must not wipe that enrollment.
        auth.enroll(admin);
        run(admin.getEmail(), TOKEN_ONE);
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ? AND status = 'ACTIVE'", admin.getId()))
                .isEqualTo(1);

        // A new token is a new decision of the operator.
        run(admin.getEmail(), TOKEN_TWO);
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isZero();
        assertThat(appliedHash()).isEqualTo(RefreshTokenService.hash(TOKEN_TWO));
    }

    @Test
    void an_unknown_email_logs_a_line_without_any_value_and_does_not_use_up_the_token() {
        String unknown = "khong-co-tai-khoan-" + UUID.randomUUID() + "@blog.local";

        try (LogCapture logs = LogCapture.of(MfaOperatorReset.class)) {
            run(unknown, TOKEN_ONE);

            assertThat(logs.messages()).containsExactly("mfa operator reset: no account matched");
            logs.assertNeverLogged(unknown, TOKEN_ONE);
        }
        // A typo is fixed without changing the token.
        assertThat(appliedHash()).isNull();
    }

    @Test
    void it_does_nothing_without_both_variables_and_refuses_a_token_that_is_too_short() {
        User admin = admin();
        auth.enroll(admin);

        try (LogCapture logs = LogCapture.of(MfaOperatorReset.class)) {
            run(null, null);
            assertThat(logs.messages()).isEmpty();
            run(admin.getEmail(), null);
            run(null, TOKEN_ONE);
            assertThat(logs.messages()).hasSize(2).allMatch(line -> line.contains("must both be set"));
        }
        assertThat(count("SELECT count(*) FROM user_mfa WHERE user_id = ?", admin.getId()))
                .isEqualTo(1);
        assertThat(appliedHash()).isNull();

        // Too short: the start is refused, naming only the variable.
        assertThatThrownBy(() -> runner(admin.getEmail(), "short-token"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("MFA_RESET_TOKEN")
                .hasMessageNotContaining("short-token");
    }

    @Test
    void the_runner_sits_after_the_admin_account_is_final_and_before_the_enrollment_code_runner() {
        int reset = order(MfaOperatorReset.class);

        assertThat(reset).isEqualTo(17);
        assertThat(reset).isGreaterThan(order(AdminSeedEmail.class));
        assertThat(reset).isGreaterThan(order(AdminPasswordFromEnvironment.class));
        assertThat(reset).isGreaterThan(order(AdminGithubLink.class));
        assertThat(reset).isGreaterThan(order(SetupCompletionFromEnvironment.class));
        assertThat(reset).isLessThan(order(MfaEnrollmentCodeRunner.class));
    }

    private static int order(Class<?> type) {
        return type.getAnnotation(Order.class).value();
    }
}
