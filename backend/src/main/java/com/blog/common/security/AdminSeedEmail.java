package com.blog.common.security;

import com.blog.auth.service.RefreshTokenService;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionException;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Renames the seeded admin row to {@code ADMIN_EMAIL} at startup, when that variable differs from
 * {@value SeedAdmin#EMAIL}.
 *
 * Previously, setting {@code ADMIN_EMAIL=me@x.com} together with a strong {@code ADMIN_PASSWORD} meant
 * AdminPasswordFromEnvironment found nobody with that address and only logged a WARN, while {@value SeedAdmin#EMAIL}
 * with the password printed in the README was still ADMIN. Now the seed row receives the new address before every other
 * runner ({@code @Order(5)}), so the password, the GitHub link and the dev-password check (DevCredentialWarning) all
 * see the admin under that address, and the old address can no longer log in.
 *
 * It only renames when all three hold: the seed row ({@link SeedAdmin#ID}) still exists with role ADMIN, it still
 * carries {@value SeedAdmin#EMAIL}, and no account carries the new address. Every startup after the first passes
 * through here doing nothing (the seed row already has the new address), with no log. A seed row that was deleted, had
 * its role changed or its email changed by hand is not touched either: that is the site owner's decision. The id stays
 * the same, so the admin's posts, comments, likes, notifications and GitHub link stay attached to the same row.
 *
 * When it renames, every session of the seed row ends ({@link RefreshTokenService#revokeAllSessions}): any session
 * opened with the old public credential, including a stranger's on an old deployment, does not survive the rename
 * (every refresh issues a new 30-day token, so without revoking, that session would never end), and an access token
 * issued before the rename is rejected at once ({@code users.tokens_valid_after}), not 15 minutes later.
 *
 * It never breaks startup: a DB error is only a WARN, like AdminGithubLink. If the seed row therefore still accepts the
 * dev password on a public site, DevCredentialWarning refuses to start. The log does not contain the new address.
 */
@Component
@Order(5)
public class AdminSeedEmail implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(AdminSeedEmail.class);

    private final String configuredEmail;
    private final JdbcTemplate jdbcTemplate;
    private final RefreshTokenService refreshTokenService;
    private final TransactionTemplate transactionTemplate;

    public AdminSeedEmail(
            AdminAccountProperties properties,
            JdbcTemplate jdbcTemplate,
            RefreshTokenService refreshTokenService,
            PlatformTransactionManager transactionManager) {
        this.configuredEmail = properties.email();
        this.jdbcTemplate = jdbcTemplate;
        this.refreshTokenService = refreshTokenService;
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    @Override
    public void run(ApplicationArguments args) {
        if (configuredEmail == null || configuredEmail.isBlank() || SeedAdmin.EMAIL.equals(configuredEmail)) {
            return;
        }
        Runnable report;
        try {
            report = transactionTemplate.execute(status -> rename());
        } catch (DataAccessException | TransactionException e) {
            log.warn("seed admin email not changed: {}", e.getClass().getName());
            return;
        }
        // Logged after the commit: only reports a rename that has really happened.
        if (report != null) {
            report.run();
        }
    }

    private Runnable rename() {
        // FOR UPDATE: if two instances start at the same time, the later one waits, then sees the row already has the
        // new address.
        List<String> seed = jdbcTemplate.query(
                "SELECT email FROM users WHERE id = ? AND role = 'ADMIN' FOR UPDATE",
                (rs, row) -> rs.getString("email"),
                SeedAdmin.ID);
        if (seed.isEmpty() || !SeedAdmin.EMAIL.equals(seed.getFirst())) {
            return null;
        }
        Boolean taken = jdbcTemplate.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM users WHERE email = ?)", Boolean.class, configuredEmail);
        if (Boolean.TRUE.equals(taken)) {
            return () -> log.warn(
                    "ADMIN_EMAIL already belongs to another account, so the seeded admin keeps {}. On a "
                            + "public site the startup check refuses to start while that account still accepts the "
                            + "development password.",
                    SeedAdmin.EMAIL);
        }
        jdbcTemplate.update(
                "UPDATE users SET email = ?, updated_at = now() WHERE id = ?", configuredEmail, SeedAdmin.ID);
        // A bulk revocation also ends the expiry (see RefreshTokenRepository.revokeAllLiveForUser): an old device
        // carrying
        // this token and coming back only gets EXPIRED, it is not treated as token reuse that would drag down the site
        // owner's new session. Same transaction as the rename.
        int revoked = refreshTokenService.revokeAllSessions(SeedAdmin.ID, Instant.now());
        return () -> log.info(
                "seeded admin account renamed from {} to ADMIN_EMAIL (same id); {} refresh token(s) " + "revoked",
                SeedAdmin.EMAIL,
                revoked);
    }
}
