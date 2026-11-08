package com.blog.auth.service;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.LogCapture;
import com.blog.user.entity.User;
import com.blog.user.entity.UserRole;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The nightly cleanup of {@code mfa_challenge}: every sign-in that stops at the second step leaves a row, and only this
 * job deletes it. Challenges that expired more than a day ago go; younger ones stay (an incident can be traced for a day),
 * and so does every live one.
 *
 * The bean is called directly, as {@link RefreshTokenCleanupIT} does: the schedule is off in every IT, and the cron wiring is
 * in {@link MfaChallengeCleanupConfigTest}. The database is shared by the whole suite, so only the rows of this test are
 * checked, never the total. Every time is hours or days away from the threshold, taken from the application clock (the
 * container's clock may differ from the JVM's by a few seconds).
 */
class MfaChallengeCleanupIT extends AbstractIntegrationTest {

    @Autowired
    private MfaChallengeCleanup cleanup;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    private User admin() {
        return auth.createAccount("cleanup-" + UUID.randomUUID() + "@blog.local", UserRole.ADMIN);
    }

    /** Inserts a challenge row that expires {@code expiresIn} from now (negative: already expired) and returns its hash. */
    private String challenge(User user, Duration expiresIn) {
        String hash = RefreshTokenService.hash(UUID.randomUUID().toString());
        Instant now = Instant.now();
        jdbcTemplate.update(
                "INSERT INTO mfa_challenge (token_hash, user_id, purpose, first_factor, expires_at, created_at) "
                        + "VALUES (?, ?, 'VERIFY', 'PASSWORD', ?, ?)",
                hash,
                user.getId(),
                Timestamp.from(now.plus(expiresIn)),
                Timestamp.from(now.minus(Duration.ofDays(3))));
        return hash;
    }

    private boolean stored(String hash) {
        return Boolean.TRUE.equals(jdbcTemplate.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM mfa_challenge WHERE token_hash = ?)", Boolean.class, hash));
    }

    @Test
    void deletes_challenges_that_expired_over_a_day_ago_and_keeps_every_younger_or_live_one() {
        User user = admin();
        String expiredTwoDaysAgo = challenge(user, Duration.ofDays(-2));
        String expiredThreeDaysAgo = challenge(user, Duration.ofDays(-3));
        String expiredHalfADayAgo = challenge(user, Duration.ofHours(-12));
        String expiredAnHourAgo = challenge(user, Duration.ofHours(-1));
        String live = challenge(user, Duration.ofMinutes(5));
        // A consumed challenge is not special: only its expiry decides.
        jdbcTemplate.update("UPDATE mfa_challenge SET consumed_at = now() WHERE token_hash = ?", expiredHalfADayAgo);

        int deleted = cleanup.run();

        assertThat(deleted).isGreaterThanOrEqualTo(2);
        assertThat(stored(expiredTwoDaysAgo)).isFalse();
        assertThat(stored(expiredThreeDaysAgo)).isFalse();
        assertThat(stored(expiredHalfADayAgo)).isTrue();
        assertThat(stored(expiredAnHourAgo)).isTrue();
        assertThat(stored(live)).isTrue();

        // Again: nothing of this test is left to delete, and the run is harmless.
        cleanup.run();
        assertThat(stored(live)).isTrue();
    }

    @Test
    void each_cleanup_logs_exactly_one_info_line_with_only_the_row_count() {
        User user = admin();
        String expired = challenge(user, Duration.ofDays(-2));

        try (LogCapture logs = LogCapture.of(MfaChallengeCleanup.class)) {
            int deleted = cleanup.run();

            assertThat(logs.messages())
                    .singleElement()
                    .satisfies(line -> assertThat(line)
                            .isEqualTo("mfa challenge cleanup: " + deleted + " expired row(s) deleted"));
            assertThat(logs.messages(Level.INFO)).hasSize(1);
            logs.assertNeverLogged(expired, user.getId().toString(), user.getEmail());
        }
    }
}
