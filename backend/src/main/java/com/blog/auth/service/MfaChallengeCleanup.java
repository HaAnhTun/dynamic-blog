package com.blog.auth.service;

import com.blog.auth.repository.MfaChallengeRepository;
import java.time.Duration;
import java.time.Instant;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Cleans the {@code mfa_challenge} table every night, with the same schedule as {@code RefreshTokenCleanup}
 * ({@code app.security.refresh-token-cleanup-cron}, default 03:17; {@code -} turns it off): every sign-in that stops at
 * the second step leaves a row, and nothing else would delete it. Challenges that expired more than a day ago go; younger
 * ones stay so an incident can be traced for a day. One DELETE reading nothing first: running with nothing to delete, or
 * two instances at once, is harmless. The log has only the row count.
 */
@Component
@RequiredArgsConstructor
public class MfaChallengeCleanup {

    private static final Logger log = LoggerFactory.getLogger(MfaChallengeCleanup.class);
    private static final Duration RETENTION = Duration.ofDays(1);

    private final MfaChallengeRepository challengeRepository;

    /** @return the number of rows deleted */
    @Scheduled(cron = "${app.security.refresh-token-cleanup-cron:0 17 3 * * *}")
    @Transactional
    public int run() {
        int deleted = challengeRepository.deleteExpiredBefore(Instant.now().minus(RETENTION));
        log.info("mfa challenge cleanup: {} expired row(s) deleted", deleted);
        return deleted;
    }
}
