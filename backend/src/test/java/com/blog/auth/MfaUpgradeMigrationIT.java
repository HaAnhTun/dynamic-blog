package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.security.SeedAdmin;
import com.blog.support.AbstractIntegrationTest;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * V44 on a database that already holds sessions, the way an upgrading site does: Flyway builds a separate DB up to V43, the
 * test writes an ADMIN with live and revoked refresh tokens plus an AUTHOR and a USER with live ones, and only then runs
 * V44. No Spring context: only the migration's SQL is checked.
 */
class MfaUpgradeMigrationIT {

    private static final Instant LONG_AGO = Instant.parse("2020-01-01T00:00:00Z");

    @Test
    void v44_ends_every_admin_session_leaves_the_others_and_adds_the_new_columns_and_tables() {
        DataSource dataSource = AbstractIntegrationTest.freshDataSource("mfa_upgrade_migration_it");
        flyway(dataSource).target("43").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);

        UUID author = account(jdbc, "AUTHOR", "author-" + UUID.randomUUID() + "@blog.local");
        UUID reader = account(jdbc, "USER", "reader-" + UUID.randomUUID() + "@blog.local");
        token(jdbc, SeedAdmin.ID, "admin-live-1", null);
        token(jdbc, SeedAdmin.ID, "admin-live-2", null);
        token(jdbc, SeedAdmin.ID, "admin-revoked-earlier", LONG_AGO);
        token(jdbc, author, "author-live", null);
        token(jdbc, reader, "reader-live", null);
        Instant before = Instant.now().minusSeconds(5);

        flyway(dataSource).target("44").load().migrate();

        // Every live ADMIN session ends: revoked and expired at once (so an old device gets EXPIRED, not reuse
        // detection).
        for (String live : List.of("admin-live-1", "admin-live-2")) {
            assertThat(revokedAt(jdbc, live)).as(live).isAfterOrEqualTo(before);
            assertThat(expiresAt(jdbc, live)).as(live).isBeforeOrEqualTo(Instant.now());
        }
        // A token revoked earlier keeps its revocation time.
        assertThat(revokedAt(jdbc, "admin-revoked-earlier")).isEqualTo(LONG_AGO);
        // The admin's access tokens that carry no sid are cut off too.
        assertThat(jdbc.queryForObject(
                        "SELECT tokens_valid_after FROM users WHERE id = ?", Timestamp.class, SeedAdmin.ID))
                .isNotNull();
        // AUTHOR and USER rows are untouched.
        for (String untouched : List.of("author-live", "reader-live")) {
            assertThat(revokedAt(jdbc, untouched)).as(untouched).isNull();
            assertThat(expiresAt(jdbc, untouched))
                    .as(untouched)
                    .isAfter(Instant.now().plusSeconds(3600));
        }
        assertThat(jdbc.queryForObject("SELECT tokens_valid_after FROM users WHERE id = ?", Timestamp.class, author))
                .isNull();
        assertThat(jdbc.queryForObject("SELECT tokens_valid_after FROM users WHERE id = ?", Timestamp.class, reader))
                .isNull();

        // Sessions that existed at upgrade count as "never recently authenticated" and have no second factor.
        assertThat(jdbc.queryForObject(
                        "SELECT count(*) FROM refresh_tokens WHERE authenticated_at <> 'epoch' OR mfa_verified_at IS NOT NULL",
                        Long.class))
                .isZero();
        // A row written without the new columns (an old backend during a rollback) gets "now" as authenticated_at.
        jdbc.update(
                "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES (?, 'written-after', now() + interval '1 day')",
                author);
        assertThat(jdbc.queryForObject(
                        "SELECT authenticated_at > now() - interval '1 minute' FROM refresh_tokens WHERE token_hash = 'written-after'",
                        Boolean.class))
                .isTrue();

        // The new columns and tables.
        assertThat(columns(jdbc, "users")).contains("mfa_enrollment_open_until");
        assertThat(columns(jdbc, "app_settings")).contains("mfa_reset_applied_hash");
        assertThat(columns(jdbc, "refresh_tokens")).contains("mfa_verified_at", "authenticated_at");
        assertThat(columns(jdbc, "user_mfa"))
                .contains(
                        "user_id",
                        "status",
                        "secret_cipher",
                        "key_id",
                        "pending_secret_cipher",
                        "pending_key_id",
                        "last_used_step",
                        "failed_attempts",
                        "locked_until",
                        "confirmed_at");
        assertThat(columns(jdbc, "user_mfa_recovery_code")).contains("user_id", "code_hash", "used_at");
        assertThat(columns(jdbc, "mfa_challenge"))
                .contains("token_hash", "user_id", "purpose", "first_factor", "attempts", "expires_at", "consumed_at");
        assertThat(jdbc.queryForObject("SELECT mfa_reset_applied_hash FROM app_settings WHERE id = 1", String.class))
                .isNull();
    }

    @Test
    void v44_constraints_refuse_wrong_values_and_delete_with_the_account() {
        DataSource dataSource = AbstractIntegrationTest.freshDataSource("mfa_constraints_migration_it");
        flyway(dataSource).load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        UUID author = account(jdbc, "AUTHOR", "author-" + UUID.randomUUID() + "@blog.local");

        assertThatThrownBy(() -> jdbc.update(
                        "INSERT INTO user_mfa (user_id, status, secret_cipher, key_id) VALUES (?, 'WRONG', '\\x00', 1)",
                        author))
                .isInstanceOf(DataIntegrityViolationException.class);
        // A pending secret and its key id come together or not at all.
        assertThatThrownBy(() -> jdbc.update(
                        "INSERT INTO user_mfa (user_id, status, secret_cipher, key_id, pending_secret_cipher) "
                                + "VALUES (?, 'ACTIVE', '\\x00', 1, '\\x01')",
                        author))
                .isInstanceOf(DataIntegrityViolationException.class);
        jdbc.update(
                "INSERT INTO user_mfa (user_id, status, secret_cipher, key_id) VALUES (?, 'ACTIVE', '\\x00', 1)",
                author);
        jdbc.update("INSERT INTO user_mfa_recovery_code (user_id, code_hash) VALUES (?, 'abc')", author);
        assertThatThrownBy(() -> jdbc.update(
                        "INSERT INTO user_mfa_recovery_code (user_id, code_hash) VALUES (?, 'abc')", author))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update(
                        "INSERT INTO mfa_challenge (token_hash, user_id, purpose, first_factor, expires_at, created_at) "
                                + "VALUES ('h1', ?, 'OTHER', 'PASSWORD', now(), now())",
                        author))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update(
                        "INSERT INTO mfa_challenge (token_hash, user_id, purpose, first_factor, expires_at, created_at) "
                                + "VALUES ('h2', ?, 'VERIFY', 'EMAIL', now(), now())",
                        author))
                .isInstanceOf(DataIntegrityViolationException.class);
        jdbc.update(
                "INSERT INTO mfa_challenge (token_hash, user_id, purpose, first_factor, expires_at, created_at) "
                        + "VALUES ('h3', ?, 'ENROLL', 'GITHUB', now(), now())",
                author);

        jdbc.update("DELETE FROM users WHERE id = ?", author);

        assertThat(jdbc.queryForObject("SELECT count(*) FROM user_mfa", Long.class))
                .isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM user_mfa_recovery_code", Long.class))
                .isZero();
        assertThat(jdbc.queryForObject("SELECT count(*) FROM mfa_challenge", Long.class))
                .isZero();
    }

    /** V34 reads the placeholder defaultLocale, which the application configuration supplies. */
    private static FluentConfiguration flyway(DataSource dataSource) {
        return Flyway.configure().dataSource(dataSource).placeholders(Map.of("defaultLocale", "vi"));
    }

    private static UUID account(JdbcTemplate jdbc, String role, String email) {
        UUID id = UUID.randomUUID();
        jdbc.update(
                "INSERT INTO users (id, email, password_hash, display_name, role, public_slug) VALUES (?, ?, 'x', ?, ?, ?)",
                id,
                email,
                role + " " + id,
                role,
                "slug-" + id);
        return id;
    }

    private static void token(JdbcTemplate jdbc, UUID user, String hash, Instant revokedAt) {
        jdbc.update(
                "INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked_at) VALUES (?, ?, now() + interval '30 days', ?)",
                user,
                hash,
                revokedAt == null ? null : Timestamp.from(revokedAt));
    }

    private static Instant revokedAt(JdbcTemplate jdbc, String hash) {
        Timestamp value = jdbc.queryForObject(
                "SELECT revoked_at FROM refresh_tokens WHERE token_hash = ?", Timestamp.class, hash);
        return value == null ? null : value.toInstant();
    }

    private static Instant expiresAt(JdbcTemplate jdbc, String hash) {
        return jdbc.queryForObject("SELECT expires_at FROM refresh_tokens WHERE token_hash = ?", Timestamp.class, hash)
                .toInstant();
    }

    private static List<String> columns(JdbcTemplate jdbc, String table) {
        return jdbc.queryForList(
                "SELECT column_name FROM information_schema.columns WHERE table_name = ?", String.class, table);
    }
}
