package com.blog.auth.service;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Refresh token cleanup: one DELETE statement each night removes expired tokens and tokens revoked longer ago than the retention time
 * (7 days by default). Live tokens and recently revoked tokens stay; a recently revoked token is what reuse detection
 * (RefreshTokenService.rotate) needs to read.
 *
 * The bean is called directly, without awaiting the schedule: the schedule is off in every IT (AbstractIntegrationTest), and the cron wiring is checked separately in
 * RefreshTokenCleanupConfigTest. The DB is shared by the whole test suite: a cleanup also deletes old rows of other classes, so only the rows
 * of this test are checked, not the total. Every timestamp is far from the threshold (hours, days), so that a container
 * Postgres clock skewed from the JVM clock by a few seconds does not change the result.
 */
class RefreshTokenCleanupIT extends AbstractIntegrationTest {

    @Autowired
    private RefreshTokenCleanup cleanup;

    @Autowired
    private RefreshTokenService refreshTokenService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    @Test
    void cleans_expired_and_tokens_revoked_over_7_days_while_live_and_recently_revoked_tokens_stay() {
        User reader = auth.createReader(
                auth.nextGithubId(), "don-token-" + UUID.randomUUID().toString().substring(0, 8));
        String live = auth.verifiedRefreshToken(reader);
        String expired = auth.verifiedRefreshToken(reader);
        set(expired, "expires_at = now() - interval '1 hour'");
        String revokedEightDaysAgo = auth.verifiedRefreshToken(reader);
        set(revokedEightDaysAgo, "revoked_at = now() - interval '8 days'");
        String revokedSixDaysAgo = auth.verifiedRefreshToken(reader);
        set(revokedSixDaysAgo, "revoked_at = now() - interval '6 days'");
        String revokedJustNow = auth.verifiedRefreshToken(reader);
        refreshTokenService.revoke(revokedJustNow);
        String expiredAndRevokedYesterday = auth.verifiedRefreshToken(reader);
        set(expiredAndRevokedYesterday, "revoked_at = now() - interval '1 day', expires_at = now() - interval '1 day'");

        int deleted = cleanup.run();

        assertThat(deleted).isGreaterThanOrEqualTo(3);
        assertThat(stored(live)).isTrue();
        assertThat(stored(revokedSixDaysAgo)).isTrue();
        assertThat(stored(revokedJustNow)).isTrue();
        assertThat(stored(expired)).isFalse();
        assertThat(stored(revokedEightDaysAgo)).isFalse();
        // A bulk revoke also ends the expiry (RefreshTokenRepository.revokeAllLiveForUser): it goes on the next
        // cleanup.
        assertThat(stored(expiredAndRevokedYesterday)).isFalse();

        // Run again immediately: nothing of this test is left to delete, no error, and the live token is still usable.
        cleanup.run();
        assertThat(stored(live)).isTrue();
        assertThat(refreshTokenService.rotate(live).newRawToken()).isNotBlank();
    }

    @Test
    void each_cleanup_logs_exactly_one_INFO_line_with_only_the_row_count() {
        User reader = auth.createReader(
                auth.nextGithubId(), "log-don-" + UUID.randomUUID().toString().substring(0, 8));
        String expired = auth.verifiedRefreshToken(reader);
        set(expired, "expires_at = now() - interval '1 hour'");
        Logger logger = (Logger) LoggerFactory.getLogger(RefreshTokenCleanup.class);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        logger.addAppender(logs);
        int deleted;
        try {
            deleted = cleanup.run();
        } finally {
            logger.detachAppender(logs);
        }

        List<ILoggingEvent> events = logs.list;
        assertThat(events).singleElement().satisfies(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.INFO);
            assertThat(event.getFormattedMessage())
                    .contains(String.valueOf(deleted))
                    .doesNotContain(
                            expired,
                            RefreshTokenService.hash(expired),
                            reader.getId().toString());
        });
    }

    private void set(String rawToken, String assignments) {
        int changed = jdbcTemplate.update(
                "UPDATE refresh_tokens SET " + assignments + " WHERE token_hash = ?",
                RefreshTokenService.hash(rawToken));
        assertThat(changed).isEqualTo(1);
    }

    private boolean stored(String rawToken) {
        return Boolean.TRUE.equals(jdbcTemplate.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM refresh_tokens WHERE token_hash = ?)",
                Boolean.class,
                RefreshTokenService.hash(rawToken)));
    }
}
