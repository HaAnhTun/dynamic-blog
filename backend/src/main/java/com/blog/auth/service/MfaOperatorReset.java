package com.blog.auth.service;

import com.blog.auth.mfa.MfaProperties;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
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
 * The operator's way back for a person who lost the phone AND the recovery codes: the person who controls the server can
 * always reset two-step verification, nobody else can. Set {@code MFA_RESET_EMAIL} to the account's email and
 * {@code MFA_RESET_TOKEN} to a fresh random value (at least 24 characters) and restart.
 *
 * <ul>
 *   <li>It acts <b>once per distinct token</b>: the SHA-256 of the token is stored in
 *       {@code app_settings.mfa_reset_applied_hash} ({@link MfaResetState}) in the same transaction as the reset, and a
 *       start that finds that hash does nothing, so a forgotten variable cannot wipe the new enrollment at every restart.
 *       A new token applies again.</li>
 *   <li>When it acts it deletes the enrollment and the recovery codes of that account, revokes every session of the account
 *       (which also moves the token cut-off, so every pending sign-in challenge is dead) and ends its challenges. It does
 *       NOT open the enrollment window: the next sign-in is an enrollment that still asks for the operator's enrollment
 *       code, and {@link MfaEnrollmentCodeRunner}, which runs after this runner, creates the file.</li>
 *   <li>One WARN line with the user id and the number of sessions revoked. The email is looked up, never logged; an unknown
 *       email logs a line without any value and does not mark the token as applied, so a typo can be fixed without
 *       changing the token.</li>
 * </ul>
 * {@code @Order(17)}: after the admin row, its email, its password and its GitHub link are final, and after the setup
 * completion ({@code SetupCompletionFromEnvironment}, 16); before {@link MfaEnrollmentCodeRunner} (18).
 *
 * It never breaks startup: a database error is one WARN line with the class name, and the site keeps running.
 */
@Component
@Order(17)
public class MfaOperatorReset implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(MfaOperatorReset.class);

    private final String email;
    private final String token;
    private final boolean tokenConfigured;
    private final JdbcTemplate jdbcTemplate;
    private final MfaResetState state;
    private final MfaService mfaService;
    private final RefreshTokenService refreshTokenService;
    private final TransactionTemplate transactionTemplate;

    public MfaOperatorReset(
            MfaProperties properties,
            JdbcTemplate jdbcTemplate,
            MfaResetState state,
            MfaService mfaService,
            RefreshTokenService refreshTokenService,
            PlatformTransactionManager transactionManager) {
        // Checked when the bean is built: a token that is too short stops the start, with a message that names only the
        // variable.
        this.token = properties.configuredResetToken();
        this.email = properties.configuredResetEmail();
        this.tokenConfigured = token != null;
        this.jdbcTemplate = jdbcTemplate;
        this.state = state;
        this.mfaService = mfaService;
        this.refreshTokenService = refreshTokenService;
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    @Override
    public void run(ApplicationArguments args) {
        if (email == null && !tokenConfigured) {
            return;
        }
        if (email == null || !tokenConfigured) {
            log.warn("mfa operator reset: MFA_RESET_EMAIL and MFA_RESET_TOKEN must both be set; nothing was reset");
            return;
        }
        Integer revoked;
        UUID[] account = new UUID[1];
        try {
            revoked = transactionTemplate.execute(status -> reset(account));
        } catch (DataAccessException | TransactionException e) {
            log.warn("mfa operator reset not applied: {}", e.getClass().getName());
            return;
        }
        // Logged after the commit: only reports a reset that has really happened.
        if (revoked != null && account[0] != null) {
            log.warn("mfa operator reset userId={} sessionsRevoked={}", account[0], revoked);
        } else if (revoked != null) {
            log.warn("mfa operator reset: no account matched");
        }
    }

    /**
     * @return null when the token was applied before (nothing to do); -1 when no account has the email; otherwise the
     *         number of sessions revoked. {@code account[0]} receives the id of the account that was reset.
     */
    private Integer reset(UUID[] account) {
        // Serialises two instances that start together: the later one waits, then finds the hash already applied.
        List<String> applied = jdbcTemplate.queryForList(
                "SELECT COALESCE(mfa_reset_applied_hash, '') FROM app_settings WHERE id = 1 FOR UPDATE", String.class);
        String hash = RefreshTokenService.hash(token);
        if (!applied.isEmpty() && hash.equals(applied.getFirst())) {
            return null;
        }
        List<UUID> found =
                jdbcTemplate.queryForList("SELECT id FROM users WHERE lower(email) = lower(?)", UUID.class, email);
        if (found.isEmpty()) {
            return -1;
        }
        UUID userId = found.getFirst();
        account[0] = userId;
        mfaService.removeEnrollment(userId, MfaService.RemovedBy.OPERATOR);
        int revoked = refreshTokenService.revokeAllSessions(userId, Instant.now());
        state.markApplied(hash);
        return revoked;
    }
}
