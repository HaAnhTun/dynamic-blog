package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.auth.dto.TokenResponse;
import com.blog.auth.service.RefreshTokenService;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import com.blog.user.repository.UserRepository;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.ObjectMapper;

/**
 * An {@code ADMIN_EMAIL} different from the default: a deployment that sets the site owner's address together with a strong {@code ADMIN_PASSWORD}.
 * Previously, {@value SeedAdmin#EMAIL} / {@value SeedAdmin#DEV_PASSWORD} were still ADMIN there.
 *
 * A separate context, because the two variables are only read at startup: AdminSeedEmail renames the email of the seed row, then
 * AdminPasswordFromEnvironment sets the password on that same row. The pair of assertions is the one in AdminPasswordFromEnvironmentIT:
 * the old credential is broken AND the new credential enters exactly the old ADMIN account (same id), not a new account.
 *
 * The seed row belongs to the whole test suite (one container for the whole JVM): {@link #restoreTheSeededAdmin} restores the email and dev password,
 * like AdminPasswordFromEnvironmentIT. The two tests that rerun the runner by hand also return the row to the renamed state themselves.
 */
@AutoConfigureMockMvc
@TestPropertySource(
        properties = {
            "app.admin.email=" + AdminSeedEmailIT.OWNER,
            "app.admin.password=" + AdminSeedEmailIT.OWNER_PASSWORD
        })
class AdminSeedEmailIT extends AbstractIntegrationTest {

    static final String OWNER = "owner-seed-email-it@example.com";
    static final String OWNER_PASSWORD = "mat-khau-that-cua-chu-site-khong-phai-ban-dev";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private AdminAccountProperties adminProperties;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private RefreshTokenService refreshTokenService;

    @Autowired
    private AuthTestSupport auth;

    @Test
    void old_address_and_dev_password_can_no_longer_log_in() throws Exception {
        login(SeedAdmin.EMAIL, SeedAdmin.DEV_PASSWORD)
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("INVALID_CREDENTIALS"));
        // No row still carries the old address, even with the new password; the new address does not accept the dev
        // password either.
        login(SeedAdmin.EMAIL, OWNER_PASSWORD)
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("INVALID_CREDENTIALS"));
        login(OWNER, SeedAdmin.DEV_PASSWORD)
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.error.code").value("INVALID_CREDENTIALS"));
        assertThat(userRepository.findByEmail(SeedAdmin.EMAIL)).isEmpty();
    }

    @Test
    void ADMIN_EMAIL_with_ADMIN_PASSWORD_enters_exactly_the_seed_ADMIN_account_with_same_id() throws Exception {
        // The whole two-step sign-in: the password under the new address, then the code of the admin's authenticator.
        TokenResponse tokens = auth.loginWithSecondStep(mockMvc, OWNER, OWNER_PASSWORD, auth.enrolledAdmin());

        mockMvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer " + tokens.accessToken()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value(SeedAdmin.ID.toString()))
                .andExpect(jsonPath("$.data.email").value(OWNER))
                .andExpect(jsonPath("$.data.role").value("ADMIN"));
    }

    @Test
    void rename_revokes_refresh_tokens_of_seed_row_and_next_startup_does_nothing() throws Exception {
        try {
            // As on the first startup with the new ADMIN_EMAIL: the seed row still has the old address and one open
            // session. updated_at
            // is moved back one day, by the DB clock: compared with now() of the DB itself, not with the JVM clock.
            jdbcTemplate.update(
                    "UPDATE users SET email = ?, updated_at = now() - interval '1 day' WHERE id = ?",
                    SeedAdmin.EMAIL,
                    SeedAdmin.ID);
            String before = auth.verifiedRefreshToken(seedAdmin());
            // An access token of the old address that is still valid: it must not outlive the rename. The cut-off set
            // by the startup rename or an earlier test is cleared first, so the token is valid whatever the clock says.
            jdbcTemplate.update("UPDATE users SET tokens_valid_after = NULL WHERE id = ?", SeedAdmin.ID);
            String accessBefore = auth.bearerIssuedAt(seedAdmin(), Instant.now().minusSeconds(30));
            mockMvc.perform(get("/api/v1/auth/me").header("Authorization", accessBefore))
                    .andExpect(status().isOk());
            Timestamp updatedBefore = updatedAt();

            runner(adminProperties).run(new DefaultApplicationArguments());

            assertThat(emailOfSeed()).isEqualTo(OWNER);
            assertThat(updatedAt()).isAfter(updatedBefore);
            // The access token goes with the rename (tokens_valid_after), it does not live out its 15 minutes.
            mockMvc.perform(get("/api/v1/auth/me").header("Authorization", accessBefore))
                    .andExpect(status().isUnauthorized());
            // EXPIRED, not REVOKED: expiry is checked before revocation.
            refresh(before)
                    .andExpect(status().isUnauthorized())
                    .andExpect(jsonPath("$.error.code").value("REFRESH_TOKEN_EXPIRED"));
            // A bulk revoke also ends the expiry: this token coming back after the grace period is not treated as
            // reuse, so it does not drag along the session opened with the new address.
            assertThat(jdbcTemplate.queryForObject(
                            "SELECT expires_at <= now() FROM refresh_tokens WHERE token_hash = ?",
                            Boolean.class,
                            RefreshTokenService.hash(before)))
                    .isTrue();

            // The next startup: the seed row already carries the new address, nothing changes, the session opened after
            // the rename is still alive.
            String after = auth.verifiedRefreshToken(seedAdmin());
            Instant cutOff = tokensValidAfterOfSeed();
            assertThat(cutOff).isNotNull();
            runner(adminProperties).run(new DefaultApplicationArguments());
            assertThat(emailOfSeed()).isEqualTo(OWNER);
            assertThat(tokensValidAfterOfSeed()).isEqualTo(cutOff);
            refresh(after).andExpect(status().isOk());
        } finally {
            renameSeedTo(OWNER);
        }
    }

    @Test
    void ADMIN_EMAIL_already_owned_by_another_account_leaves_seed_row_unchanged() throws Exception {
        String taken = "da-co-chu-" + UUID.randomUUID().toString().substring(0, 8) + "@example.com";
        User other = auth.createAccount(taken, UserRole.AUTHOR);
        try {
            jdbcTemplate.update("UPDATE users SET email = ? WHERE id = ?", SeedAdmin.EMAIL, SeedAdmin.ID);

            runner(new AdminAccountProperties(taken, null, null)).run(new DefaultApplicationArguments());

            // No overwrite, no UNIQUE violation, no startup failure: the seed row keeps the old address, the other
            // account keeps its own.
            assertThat(emailOfSeed()).isEqualTo(SeedAdmin.EMAIL);
            assertThat(userRepository.findById(other.getId()).orElseThrow().getEmail())
                    .isEqualTo(taken);
        } finally {
            renameSeedTo(OWNER);
        }
    }

    @Test
    void demoted_seed_row_is_not_renamed_not_promoted_again_and_its_sessions_are_untouched() {
        try {
            // As on the first startup with the new ADMIN_EMAIL, after the site owner has demoted the seed row.
            renameSeedTo(SeedAdmin.EMAIL);
            auth.setRole(SeedAdmin.ID, UserRole.AUTHOR);
            String session = auth.verifiedRefreshToken(seedAdmin());

            runner(adminProperties).run(new DefaultApplicationArguments());

            assertThat(emailOfSeed()).isEqualTo(SeedAdmin.EMAIL);
            assertThat(jdbcTemplate.queryForObject("SELECT role FROM users WHERE id = ?", String.class, SeedAdmin.ID))
                    .isEqualTo("AUTHOR");
            assertThat(jdbcTemplate.queryForObject(
                            "SELECT revoked_at IS NULL FROM refresh_tokens WHERE token_hash = ?",
                            Boolean.class,
                            RefreshTokenService.hash(session)))
                    .isTrue();
        } finally {
            auth.setRole(SeedAdmin.ID, UserRole.ADMIN);
            renameSeedTo(OWNER);
        }
    }

    @Test
    void default_or_empty_ADMIN_EMAIL_changes_nothing() {
        try {
            jdbcTemplate.update("UPDATE users SET email = ? WHERE id = ?", SeedAdmin.EMAIL, SeedAdmin.ID);

            runner(new AdminAccountProperties(SeedAdmin.EMAIL, null, null)).run(new DefaultApplicationArguments());
            runner(new AdminAccountProperties("", null, null)).run(new DefaultApplicationArguments());
            runner(new AdminAccountProperties(null, null, null)).run(new DefaultApplicationArguments());

            assertThat(emailOfSeed()).isEqualTo(SeedAdmin.EMAIL);
        } finally {
            renameSeedTo(OWNER);
        }
    }

    // --- Helpers ---------------------------------------------------------------------------------------

    private AdminSeedEmail runner(AdminAccountProperties properties) {
        return new AdminSeedEmail(properties, jdbcTemplate, refreshTokenService, transactionManager);
    }

    private User seedAdmin() {
        return userRepository.findById(SeedAdmin.ID).orElseThrow();
    }

    private String emailOfSeed() {
        return jdbcTemplate.queryForObject("SELECT email FROM users WHERE id = ?", String.class, SeedAdmin.ID);
    }

    private Timestamp updatedAt() {
        return jdbcTemplate.queryForObject("SELECT updated_at FROM users WHERE id = ?", Timestamp.class, SeedAdmin.ID);
    }

    private Instant tokensValidAfterOfSeed() {
        Timestamp cutOff = jdbcTemplate.queryForObject(
                "SELECT tokens_valid_after FROM users WHERE id = ?", Timestamp.class, SeedAdmin.ID);
        return cutOff == null ? null : cutOff.toInstant();
    }

    private void renameSeedTo(String email) {
        jdbcTemplate.update("UPDATE users SET email = ? WHERE id = ?", email, SeedAdmin.ID);
    }

    private ResultActions login(String email, String password) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/login")
                .contentType(APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("email", email, "password", password))));
    }

    private ResultActions refresh(String refreshToken) throws Exception {
        return mockMvc.perform(post("/api/v1/auth/refresh")
                .contentType(APPLICATION_JSON)
                .content(objectMapper.writeValueAsString(Map.of("refreshToken", refreshToken))));
    }

    /**
     * Returns the seed row exactly as the migration left it: email {@value SeedAdmin#EMAIL} and the dev password, like
     * AdminPasswordFromEnvironmentIT. Without this step, every test class that runs later (AuthTestSupport.bearerForAdmin,
     * PasswordEncoderIT, admin12345 login) breaks depending on run order, not in this class itself.
     */
    @AfterAll
    static void restoreTheSeededAdmin(@Autowired UserRepository users, @Autowired PasswordEncoder encoder) {
        User admin = users.findById(SeedAdmin.ID).orElseThrow();
        admin.setEmail(SeedAdmin.EMAIL);
        admin.setPasswordHash(encoder.encode(SeedAdmin.DEV_PASSWORD));
        users.save(admin);
    }
}
