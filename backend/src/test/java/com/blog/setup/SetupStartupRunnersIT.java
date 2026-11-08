package com.blog.setup;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.blog.common.security.AdminAccountProperties;
import com.blog.common.security.ProductionMode;
import com.blog.common.security.SeedAdmin;
import com.blog.setup.config.SetupProperties;
import com.blog.setup.service.SetupAccounts;
import com.blog.setup.service.SetupCodeStore;
import com.blog.setup.service.SetupCompletionFromEnvironment;
import com.blog.setup.service.SetupDevSeedLock;
import com.blog.setup.service.SetupState;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.repository.UserRepository;
import java.nio.file.Path;
import java.sql.Timestamp;
import java.time.Instant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * The two startup runners around setup, on a fresh database: the dev-seed lock (what a fresh install looks like after
 * startup, idempotence, an existing deployment left alone) and the completion from the environment (ADMIN_PASSWORD
 * applied, ADMIN_GITHUB_ID linked, and the cases that must leave setup open). The runners are called directly with the
 * configuration under test; each test after the first restores "setup required" first.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class SetupStartupRunnersIT extends SetupIntegrationTest {

    private static final Path DATA_DIR = temporaryDirectory("setup-runners-it");
    private static final String ADMIN_PASSWORD = "operator-chosen-password";

    @DynamicPropertySource
    static void isolated(DynamicPropertyRegistry registry) {
        AbstractIntegrationTest.useFreshDatabase(registry, "setup_runners_it");
        registry.add("app.setup.data-dir", DATA_DIR::toString);
    }

    @Autowired
    private SetupState state;

    @Autowired
    private SetupCodeStore codeStore;

    @Autowired
    private SetupAccounts accounts;

    @Autowired
    private PasswordEncoder passwordEncoder;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private ProductionMode productionMode;

    @Autowired
    private SetupProperties properties;

    @BeforeEach
    void onTheDedicatedDatabase() {
        assertThat(jdbcTemplate.queryForObject("SELECT current_database()", String.class))
                .isEqualTo("setup_runners_it");
    }

    @Test
    @Order(1)
    void startup_of_a_fresh_install_disables_the_dev_password_and_leaves_setup_open() throws Exception {
        assertThat(seedHash()).isEqualTo(SetupAccounts.UNUSABLE_PASSWORD_HASH);
        assertThat(setupRequired()).isTrue();
        assertThat(DATA_DIR.resolve("setup-code")).isRegularFile();
        assertError(login(SeedAdmin.EMAIL, SeedAdmin.DEV_PASSWORD), 401, "INVALID_CREDENTIALS");
    }

    @Test
    @Order(2)
    void the_lock_is_idempotent_and_relocks_a_dev_hash_revoking_its_sessions() throws Exception {
        reopenSetup();
        Timestamp before = seedUpdatedAt();
        lock(true).run(new DefaultApplicationArguments());
        assertThat(seedHash()).isEqualTo(SetupAccounts.UNUSABLE_PASSWORD_HASH);
        assertThat(seedUpdatedAt()).isEqualTo(before);

        setSeedHash(passwordEncoder.encode(SeedAdmin.DEV_PASSWORD));
        jdbcTemplate.update(
                "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, 'runners-it-token', "
                        + "now() + interval '1 day')",
                SeedAdmin.ID);
        // An access token signed in with the development password a moment ago: valid until the lock runs. The cut-off
        // of an earlier step is cleared first, so the token is valid whatever the clock says.
        jdbcTemplate.update("UPDATE users SET tokens_valid_after = NULL WHERE id = ?", SeedAdmin.ID);
        String withTheDevPassword = auth.bearerIssuedAt(
                userRepository.findById(SeedAdmin.ID).orElseThrow(),
                Instant.now().minusSeconds(30));
        assertThat(meStatus(withTheDevPassword)).isEqualTo(200);
        lock(true).run(new DefaultApplicationArguments());
        assertThat(seedHash()).isEqualTo(SetupAccounts.UNUSABLE_PASSWORD_HASH);
        assertThat(liveSeedTokens()).isZero();
        // The access token goes with the password it was obtained with (tokens_valid_after), not 15 minutes later.
        assertThat(meStatus(withTheDevPassword)).isEqualTo(401);
    }

    @Test
    @Order(3)
    void the_lock_leaves_a_completed_install_and_a_disabled_lock_alone() {
        String devHash = passwordEncoder.encode(SeedAdmin.DEV_PASSWORD);
        setSeedHash(devHash);
        jdbcTemplate.update("UPDATE app_settings SET setup_completed = TRUE, setup_completed_at = now() WHERE id = 1");
        lock(true).run(new DefaultApplicationArguments());
        assertThat(seedHash()).isEqualTo(devHash);

        reopenSetup();
        lock(false).run(new DefaultApplicationArguments());
        assertThat(seedHash()).isEqualTo(devHash);

        lock(true).run(new DefaultApplicationArguments());
        assertThat(seedHash()).isEqualTo(SetupAccounts.UNUSABLE_PASSWORD_HASH);
    }

    @Test
    @Order(4)
    void an_admin_password_that_was_applied_closes_setup_and_deletes_the_code_file() throws Exception {
        reopenSetup();
        codeStore.ensureFile();

        // Nothing configured, or a password that is not (yet) the admin's: setup stays open.
        completion(null, null).run(new DefaultApplicationArguments());
        completion(ADMIN_PASSWORD, null).run(new DefaultApplicationArguments());
        assertThat(setupCompletedInDatabase()).isFalse();
        assertThat(DATA_DIR.resolve("setup-code")).exists();

        setSeedHash(passwordEncoder.encode(ADMIN_PASSWORD));
        completion(ADMIN_PASSWORD, null).run(new DefaultApplicationArguments());
        assertThat(setupCompletedInDatabase()).isTrue();
        assertThat(setupRequired()).isFalse();
        assertThat(DATA_DIR.resolve("setup-code")).doesNotExist();
    }

    @Test
    @Order(5)
    void a_linked_admin_github_id_closes_setup_and_an_unlinked_one_does_not() {
        reopenSetup();
        completion(null, "4242").run(new DefaultApplicationArguments());
        assertThat(setupCompletedInDatabase()).isFalse();

        jdbcTemplate.update("UPDATE users SET github_id = 4242 WHERE id = ?", SeedAdmin.ID);
        completion(null, "4242").run(new DefaultApplicationArguments());
        assertThat(setupCompletedInDatabase()).isTrue();
        jdbcTemplate.update("UPDATE users SET github_id = NULL WHERE id = ?", SeedAdmin.ID);
    }

    private SetupDevSeedLock lock(boolean enabled) {
        SetupProperties configured = new SetupProperties(properties.token(), properties.dataDir(), enabled);
        return new SetupDevSeedLock(configured, state, accounts, passwordEncoder, transactionManager, productionMode);
    }

    private SetupCompletionFromEnvironment completion(String password, String githubId) {
        return new SetupCompletionFromEnvironment(
                new AdminAccountProperties(SeedAdmin.EMAIL, password, githubId),
                state,
                codeStore,
                jdbcTemplate,
                passwordEncoder,
                transactionManager);
    }

    private void reopenSetup() {
        jdbcTemplate.update("UPDATE app_settings SET setup_completed = FALSE, setup_completed_at = NULL WHERE id = 1");
    }

    private String seedHash() {
        return jdbcTemplate.queryForObject("SELECT password_hash FROM users WHERE id = ?", String.class, SeedAdmin.ID);
    }

    private Timestamp seedUpdatedAt() {
        return jdbcTemplate.queryForObject("SELECT updated_at FROM users WHERE id = ?", Timestamp.class, SeedAdmin.ID);
    }

    private void setSeedHash(String hash) {
        jdbcTemplate.update("UPDATE users SET password_hash = ? WHERE id = ?", hash, SeedAdmin.ID);
    }

    private int meStatus(String authorization) throws Exception {
        return mockMvc.perform(get("/api/v1/auth/me").header("Authorization", authorization))
                .andReturn()
                .getResponse()
                .getStatus();
    }

    private long liveSeedTokens() {
        return jdbcTemplate.queryForObject(
                "SELECT count(*) FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL",
                Long.class,
                SeedAdmin.ID);
    }
}
