package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.auth.dto.TokenResponse;
import com.blog.auth.repository.RefreshTokenRepository;
import com.blog.auth.service.MfaService;
import com.blog.auth.service.RefreshTokenService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.LogAssertions;
import com.blog.support.LogCapture;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.repository.UserRepository;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * ADMIN_PASSWORD, applied at startup.
 *
 * This runs in its own application context because the property has to be set before the
 * runner executes — which is also the realistic shape: the variable is read once, at boot.
 * The context is cached by its property set, so this costs one extra startup for the run
 * and not one per test.
 *
 * The assertion that matters is the pair. "The new password works" alone would pass if the
 * encoder accepted anything; "the old password fails" alone would pass if the account were
 * simply broken. Together they say the password was replaced.
 */
@AutoConfigureMockMvc
@TestPropertySource(properties = "app.admin.password=a-real-production-password-not-the-dev-one")
class AdminPasswordFromEnvironmentIT extends AbstractIntegrationTest {

    private static final String CONFIGURED = "a-real-production-password-not-the-dev-one";
    private static final String DEV = "admin12345";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private RefreshTokenRepository refreshTokenRepository;

    @Autowired
    private RefreshTokenService refreshTokenService;

    @Autowired
    private PasswordPolicy passwordPolicy;

    @Autowired
    private MfaService mfaService;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Test
    void theConfiguredPasswordReplacesTheSeededOne() throws Exception {
        // The password is the first factor: it is accepted (202, the second step is due), and there is no token yet.
        login(CONFIGURED)
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.data.challenge").isNotEmpty())
                .andExpect(jsonPath("$.data.accessToken").doesNotExist());
    }

    @Test
    void theDevelopmentPasswordNoLongerWorks() throws Exception {
        // The half that makes this a test of replacement rather than of the encoder. Without
        // it, a runner that created a second admin account — or did nothing at all while the
        // seeded hash happened to verify both — would look identical.
        login(DEV)
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("INVALID_CREDENTIALS"));
    }

    // --- Changing the password revokes sessions -------------------------------------------------------------
    //
    // The runner is built by hand on a separate account, like UserEntityWriteIT: the seed admin row belongs to the
    // whole test suite, and
    // this context already ran the real runner once at startup. As at startup, run() runs inside a transaction.

    @Test
    void configured_password_that_really_changes_revokes_every_open_session_of_that_account_and_keeps_role() {
        String email = "doi-mat-khau-" + UUID.randomUUID().toString().substring(0, 8) + "@blog.local";
        // An ADMIN that was demoted: the runner still does not distinguish roles when setting the password, and does
        // not promote again.
        User account = accountWithPassword(email, "mat-khau-cu-it-nhat-12-ky-tu", UserRole.ADMIN);
        auth.setRole(account.getId(), UserRole.AUTHOR);
        String laptop = auth.verifiedRefreshToken(account);
        String phone = auth.verifiedRefreshToken(account);
        String someoneElse = auth.verifiedRefreshToken(auth.createReader(
                auth.nextGithubId(),
                "nguoi-khac-" + UUID.randomUUID().toString().substring(0, 8)));

        applyAtStartup(email, "mat-khau-moi-it-nhat-12-ky-tu");

        String hash = passwordHashOf(account);
        assertThat(passwordEncoder.matches("mat-khau-moi-it-nhat-12-ky-tu", hash))
                .isTrue();
        assertThat(passwordEncoder.matches("mat-khau-cu-it-nhat-12-ky-tu", hash))
                .isFalse();
        // A session opened with the old password, even by someone who knows it, dies at the next refresh.
        assertThat(revokedAt(laptop)).isNotNull();
        assertThat(revokedAt(phone)).isNotNull();
        assertThat(revokedAt(someoneElse)).isNull();
        // An access token issued before the change is rejected at once (tokens_valid_after).
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT tokens_valid_after FROM users WHERE id = ?", Object.class, account.getId()))
                .isNotNull();
        assertThat(jdbcTemplate.queryForObject("SELECT role FROM users WHERE id = ?", String.class, account.getId()))
                .isEqualTo("AUTHOR");
    }

    @Test
    void restart_with_the_same_password_does_not_rewrite_hash_and_logs_nobody_out() {
        String email = "giu-mat-khau-" + UUID.randomUUID().toString().substring(0, 8) + "@blog.local";
        User account = accountWithPassword(email, "mat-khau-giu-nguyen-12-ky-tu", UserRole.AUTHOR);
        String hashBefore = passwordHashOf(account);
        String session = auth.verifiedRefreshToken(account);

        applyAtStartup(email, "mat-khau-giu-nguyen-12-ky-tu");

        // Argon2 is salted: writing the same password again would give a different string. Exactly the old string means
        // nothing was written.
        assertThat(passwordHashOf(account)).isEqualTo(hashBefore);
        assertThat(revokedAt(session)).isNull();
    }

    // --- The in-app password change is refused while the variable is set --------------------------------------

    @Test
    void while_ADMIN_PASSWORD_is_set_the_password_cannot_be_changed_in_the_app_and_nothing_is_revoked()
            throws Exception {
        // The variable would silently undo the change at the next start (and sign everyone out again), so the answer is
        // a
        // 409 before anything else is checked: the password, the code, the recent sign-in.
        User seed = userRepository.findByEmail("admin@blog.local").orElseThrow();
        TokenResponse session = auth.verifiedSession(seed);
        String hashBefore = passwordHashOf(seed);

        mockMvc.perform(post("/api/v1/me/password")
                        .header("Authorization", "Bearer " + session.accessToken())
                        .contentType(APPLICATION_JSON)
                        .content("{\"currentPassword\":\"sai\",\"newPassword\":\"mat-khau-moi-dai-va-khac-biet-77\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("PASSWORD_MANAGED_BY_ENVIRONMENT"));

        assertThat(passwordHashOf(seed)).isEqualTo(hashBefore);
        // Nothing was revoked: the session still works.
        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + session.accessToken()))
                .andExpect(status().isOk());
        // The status page is told, so it explains instead of offering the form.
        mockMvc.perform(get("/api/v1/me/mfa").header("Authorization", "Bearer " + session.accessToken()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.passwordManagedByEnvironment").value(true))
                .andExpect(jsonPath("$.data.hasPassword").value(true));
    }

    @Test
    void a_real_change_clears_the_failure_counters_and_the_lock_of_the_second_step_and_a_restart_does_not() {
        String email = "dem-lan-sai-" + UUID.randomUUID().toString().substring(0, 8) + "@blog.local";
        User account = accountWithPassword(email, "mat-khau-cu-it-nhat-12-ky-tu", UserRole.ADMIN);
        auth.enroll(account);
        Runnable freeze = () -> jdbcTemplate.update(
                "UPDATE user_mfa SET failed_attempts = 100, locked_until = now() + interval '15 minutes' "
                        + "WHERE user_id = ?",
                account.getId());
        freeze.run();

        // A restart with the same password changes nothing, so it does not undo a freeze.
        applyAtStartup(email, "mat-khau-cu-it-nhat-12-ky-tu");
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT failed_attempts FROM user_mfa WHERE user_id = ?", Integer.class, account.getId()))
                .isEqualTo(100);

        // The owner changes ADMIN_PASSWORD: that is the documented answer to a frozen or kept-locked second step.
        applyAtStartup(email, "mat-khau-moi-it-nhat-12-ky-tu");
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT failed_attempts FROM user_mfa WHERE user_id = ?", Integer.class, account.getId()))
                .isZero();
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT locked_until IS NULL FROM user_mfa WHERE user_id = ?", Boolean.class, account.getId()))
                .isTrue();
    }

    // --- The password policy -------------------------------------------------------------------------------

    @Test
    void a_changed_value_that_fails_the_password_policy_stops_the_start_and_writes_nothing() {
        String email = "chinh-sach-" + UUID.randomUUID().toString().substring(0, 8) + "@blog.local";
        User account = accountWithPassword(email, "mat-khau-cu-it-nhat-12-ky-tu", UserRole.AUTHOR);
        String hashBefore = passwordHashOf(account);
        String session = auth.verifiedRefreshToken(account);

        assertThatThrownBy(() -> applyAtStartup(email, "password1234"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("password policy")
                .hasMessageNotContaining("password1234");

        assertThat(passwordHashOf(account)).isEqualTo(hashBefore);
        assertThat(revokedAt(session)).isNull();
    }

    @Test
    void an_unchanged_value_that_the_policy_now_rejects_only_warns_and_nobody_is_signed_out() {
        String email = "chinh-sach-cu-" + UUID.randomUUID().toString().substring(0, 8) + "@blog.local";
        User account = accountWithPassword(email, "welcome12345", UserRole.AUTHOR);
        String hashBefore = passwordHashOf(account);
        String session = auth.verifiedRefreshToken(account);

        Logger logger = (Logger) LoggerFactory.getLogger(AdminPasswordFromEnvironment.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            applyAtStartup(email, "welcome12345");
        } finally {
            logger.detachAppender(appender);
        }

        assertThat(passwordHashOf(account)).isEqualTo(hashBefore);
        assertThat(revokedAt(session)).isNull();
        assertThat(appender.list).hasSize(1);
        assertThat(appender.list.getFirst().getLevel()).isEqualTo(Level.WARN);
        LogAssertions.assertNoValues(appender.list, "welcome12345", email);
    }

    @Test
    void the_lines_of_the_runner_name_the_account_by_id_and_never_write_the_configured_email() {
        String email = "khong-ghi-log-" + UUID.randomUUID().toString().substring(0, 8) + "@blog.local";
        User account = accountWithPassword(email, "mat-khau-cu-it-nhat-12-ky-tu", UserRole.AUTHOR);

        try (LogCapture logs = LogCapture.of(AdminPasswordFromEnvironment.class)) {
            applyAtStartup(email, "mat-khau-moi-it-nhat-12-ky-tu");

            assertThat(logs.messages())
                    .singleElement()
                    .asString()
                    .startsWith("Applied ADMIN_PASSWORD")
                    .contains("userId=" + account.getId());
            LogAssertions.assertNoValues(logs.events(), email, "@blog.local", "mat-khau-moi-it-nhat-12-ky-tu");
        }

        String unknown = "khong-co-tai-khoan-" + UUID.randomUUID().toString().substring(0, 8) + "@blog.local";
        try (LogCapture logs = LogCapture.of(AdminPasswordFromEnvironment.class)) {
            applyAtStartup(unknown, "mat-khau-moi-it-nhat-12-ky-tu");

            assertThat(logs.messages()).singleElement().asString().contains("ADMIN_PASSWORD is set but no user");
            LogAssertions.assertNoValues(logs.events(), unknown, "@blog.local");
        }
    }

    private User accountWithPassword(String email, String password, UserRole role) {
        User account = auth.createAccount(email, role);
        account.setPasswordHash(passwordEncoder.encode(password));
        return userRepository.save(account);
    }

    private void applyAtStartup(String email, String password) {
        AdminAccountProperties properties = new Binder(new MapConfigurationPropertySource(Map.of(
                        "app.admin.email", email,
                        "app.admin.password", password)))
                .bind("app.admin", AdminAccountProperties.class)
                .get();
        AdminPasswordFromEnvironment runner = new AdminPasswordFromEnvironment(
                userRepository, passwordEncoder, properties, refreshTokenService, passwordPolicy, mfaService);
        new TransactionTemplate(transactionManager)
                .executeWithoutResult(status -> runner.run(new DefaultApplicationArguments()));
    }

    private String passwordHashOf(User account) {
        return jdbcTemplate.queryForObject(
                "SELECT password_hash FROM users WHERE id = ?", String.class, account.getId());
    }

    private Instant revokedAt(String rawToken) {
        return refreshTokenRepository
                .findByTokenHash(RefreshTokenService.hash(rawToken))
                .orElseThrow()
                .getRevokedAt();
    }

    private org.springframework.test.web.servlet.ResultActions login(String password) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/login")
                .contentType(APPLICATION_JSON)
                .content("{\"email\":\"admin@blog.local\",\"password\":\"" + password + "\"}"));
    }

    /**
     * Puts the seeded development password back.
     *
     * This class mutates state the whole suite shares: AbstractIntegrationTest keeps one
     * container for the JVM, so the admin row this context rewrote is the same row every
     * other test class reads. Without this, PasswordEncoderIT's
     * {@code seededAdminPasswordVerifies} fails — not always, but whenever it happens to run
     * after this class, which is the worst shape a test failure can have.
     *
     * Found by running the full suite rather than this file alone. The test passed in
     * isolation and broke a file it never mentions.
     */
    @AfterAll
    static void restoreTheSeededPassword(@Autowired UserRepository users, @Autowired PasswordEncoder encoder) {
        User admin = users.findByEmail("admin@blog.local").orElseThrow();
        admin.setPasswordHash(encoder.encode(DEV));
        users.save(admin);
    }
}
