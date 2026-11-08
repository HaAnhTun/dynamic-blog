package com.blog.auth.service;

import com.blog.auth.repository.RefreshTokenRepository;
import com.blog.common.config.SecurityProperties;
import java.time.Instant;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Cleans the refresh_tokens table every night. Every login and every token rotation adds a row, and previously nothing
 * deleted them: a dev machine had about 2,350 rows after four days.
 *
 * It deletes expired tokens, and tokens revoked before {@code app.security.refresh-token-revoked-retention} (default 7
 * days). Revoked tokens are not deleted right away: during the retention period, presenting a rotated or logged-out
 * token again counts as reuse (RefreshTokenService.rotate); afterwards the row disappears, and that token is just
 * REFRESH_TOKEN_INVALID like any unknown string.
 *
 * The run time is {@code app.security.refresh-token-cleanup-cron}, default 03:17 every day in the JVM's time zone, i.e.
 * UTC (the Dockerfile, spring-boot-maven-plugin and surefire all set -Duser.timezone=UTC): 10:17 Vietnam time;
 * {@code -} turns it off entirely. A single DELETE ({@link RefreshTokenRepository#deleteExpiredOrRevokedBefore}):
 * running with nothing to delete, or two instances running at once, is harmless. The log has only the row count.
 */
@Component
@RequiredArgsConstructor
public class RefreshTokenCleanup {

    private static final Logger log = LoggerFactory.getLogger(RefreshTokenCleanup.class);

    private final RefreshTokenRepository refreshTokenRepository;
    private final SecurityProperties properties;

    /** @return the number of rows deleted */
    @Scheduled(cron = "${app.security.refresh-token-cleanup-cron:0 17 3 * * *}")
    @Transactional
    public int run() {
        Instant now = Instant.now();
        int deleted = refreshTokenRepository.deleteExpiredOrRevokedBefore(
                now, now.minus(properties.refreshTokenRevokedRetention()));
        log.info("refresh token cleanup: {} expired or long-revoked row(s) deleted", deleted);
        return deleted;
    }
}
