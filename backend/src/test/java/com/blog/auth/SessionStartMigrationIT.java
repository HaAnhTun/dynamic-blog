package com.blog.auth;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.support.AbstractIntegrationTest;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * V45 on a database that already holds sessions, the way an upgrading site does: Flyway builds a separate DB up to V44, the
 * test writes sessions that carry the 'epoch' marker of V44 (and one with a real start), and only then runs V45. No Spring
 * context: only the migration's SQL is checked.
 */
class SessionStartMigrationIT {

    private static final Instant EPOCH = Instant.EPOCH;

    @Test
    void v45_gives_the_sessions_of_the_two_step_release_a_real_old_start_and_leaves_real_starts_alone() {
        DataSource dataSource = AbstractIntegrationTest.freshDataSource("session_start_migration_it");
        flyway(dataSource).target("44").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);

        UUID author = account(jdbc, "AUTHOR");
        // A session in daily use: three tokens of one session, the oldest created four days ago, all with the marker.
        UUID busy = UUID.randomUUID();
        row(jdbc, author, "busy-1", busy, EPOCH, now.minus(Duration.ofDays(4)));
        row(jdbc, author, "busy-2", busy, EPOCH, now.minus(Duration.ofDays(2)));
        row(jdbc, author, "busy-3", busy, EPOCH, now.minus(Duration.ofHours(1)));
        // A session whose only row is an hour old: still older than a day after the migration.
        UUID fresh = UUID.randomUUID();
        row(jdbc, author, "fresh-1", fresh, EPOCH, now.minus(Duration.ofHours(1)));
        // A session with a real start (signed in after V44): not touched.
        UUID real = UUID.randomUUID();
        Instant realStart = now.minus(Duration.ofDays(9));
        row(jdbc, author, "real-1", real, realStart, now.minus(Duration.ofDays(9)));
        row(jdbc, author, "real-2", real, realStart, now.minus(Duration.ofMinutes(5)));

        flyway(dataSource).target("45").load().migrate();

        // Every row of a session has the same start: the first row of the session that still exists.
        Instant busyStart = now.minus(Duration.ofDays(4));
        for (String hash : new String[] {"busy-1", "busy-2", "busy-3"}) {
            assertThat(authenticatedAt(jdbc, hash)).as(hash).isEqualTo(busyStart);
        }
        // Never less than a day old, so the session is still not "recently authenticated".
        assertThat(authenticatedAt(jdbc, "fresh-1"))
                .isBeforeOrEqualTo(Instant.now().minus(Duration.ofDays(1)).plusSeconds(60))
                .isAfter(Instant.now().minus(Duration.ofDays(1)).minusSeconds(600));
        // A real start stays.
        assertThat(authenticatedAt(jdbc, "real-1")).isEqualTo(realStart);
        assertThat(authenticatedAt(jdbc, "real-2")).isEqualTo(realStart);
        // Nothing carries the marker any more, and the migration touched no other column.
        assertThat(jdbc.queryForObject(
                        "SELECT count(*) FROM refresh_tokens WHERE authenticated_at = 'epoch'", Long.class))
                .isZero();
        assertThat(jdbc.queryForObject(
                        "SELECT count(*) FROM refresh_tokens WHERE revoked_at IS NOT NULL OR mfa_verified_at IS NOT NULL",
                        Long.class))
                .isZero();
    }

    /** V34 reads the placeholder defaultLocale, which the application configuration supplies. */
    private static FluentConfiguration flyway(DataSource dataSource) {
        return Flyway.configure().dataSource(dataSource).placeholders(Map.of("defaultLocale", "vi"));
    }

    private static UUID account(JdbcTemplate jdbc, String role) {
        UUID id = UUID.randomUUID();
        jdbc.update(
                "INSERT INTO users (id, email, password_hash, display_name, role, public_slug) VALUES (?, ?, 'x', ?, ?, ?)",
                id,
                "u-" + id + "@blog.local",
                role + " " + id,
                role,
                "slug-" + id);
        return id;
    }

    private static void row(
            JdbcTemplate jdbc, UUID user, String hash, UUID session, Instant authenticatedAt, Instant createdAt) {
        jdbc.update(
                "INSERT INTO refresh_tokens (user_id, token_hash, session_id, authenticated_at, expires_at, created_at) "
                        + "VALUES (?, ?, ?, ?, now() + interval '10 days', ?)",
                user,
                hash,
                session,
                Timestamp.from(authenticatedAt),
                Timestamp.from(createdAt));
    }

    private static Instant authenticatedAt(JdbcTemplate jdbc, String hash) {
        return jdbc.queryForObject(
                        "SELECT authenticated_at FROM refresh_tokens WHERE token_hash = ?", Timestamp.class, hash)
                .toInstant();
    }
}
