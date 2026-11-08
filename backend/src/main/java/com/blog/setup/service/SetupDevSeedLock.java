package com.blog.setup.service;

import com.blog.common.security.ProductionMode;
import com.blog.common.security.SeedAdmin;
import com.blog.setup.config.SetupProperties;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DataAccessException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionException;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * On a fresh, unclaimed install the seeded admin still accepts the development password printed in the README: anyone
 * could sign in as the site owner before the real owner runs /setup. While setup is required (and
 * {@code app.setup.lock-dev-seed} is on, the default), this runner replaces that password hash with
 * {@link SetupAccounts#UNUSABLE_PASSWORD_HASH} and ends the row's sessions (refresh tokens revoked, access tokens
 * issued so far rejected through {@code users.tokens_valid_after}). Setup gives the row a real password.
 *
 * Idempotent: the marker no longer verifies against the dev password, so the next start does nothing, without even
 * running Argon2. An existing deployment is never touched: setup is completed there (V36), and the state is read under
 * the setup lock, so a /setup that completes concurrently is seen. {@code @Order(3)}: before AdminSeedEmail (5),
 * AdminPasswordFromEnvironment (10), which then replaces the marker with {@code ADMIN_PASSWORD}, and DevCredentialWarning
 * (20), which then no longer finds the dev password.
 *
 * On a production run ({@link ProductionMode}) this is the first line against the default credential, so it cannot be
 * switched off and it cannot fail quietly: {@code SETUP_LOCK_DEV_SEED=false} is ignored there, and a database error
 * stops the start (the restart policy tries again, the runner is idempotent) instead of leaving the development
 * password in place with one log line. On an opted-in dev machine the switch is honoured and a database error is one
 * WARN line, as before.
 */
@Component
@Order(3)
public class SetupDevSeedLock implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(SetupDevSeedLock.class);

    private final boolean enabled;
    private final ProductionMode productionMode;
    private final SetupState state;
    private final SetupAccounts accounts;
    private final PasswordEncoder passwordEncoder;
    private final TransactionTemplate transactionTemplate;

    public SetupDevSeedLock(
            SetupProperties properties,
            SetupState state,
            SetupAccounts accounts,
            PasswordEncoder passwordEncoder,
            PlatformTransactionManager transactionManager,
            ProductionMode productionMode) {
        this.enabled = properties.lockDevSeed();
        this.productionMode = productionMode;
        this.state = state;
        this.accounts = accounts;
        this.passwordEncoder = passwordEncoder;
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    @Override
    public void run(ApplicationArguments args) {
        boolean production = productionMode.active();
        if (!enabled && !production) {
            return;
        }
        Integer revoked;
        try {
            revoked = transactionTemplate.execute(status -> lock());
        } catch (DataAccessException | TransactionException e) {
            if (production) {
                log.error(
                        "seeded admin development password could not be disabled on a production run: {}",
                        e.getClass().getName());
                throw e;
            }
            log.warn(
                    "seeded admin development password not disabled: {}",
                    e.getClass().getName());
            return;
        }
        // Logged after the commit: only reports a change that has really happened.
        if (revoked != null) {
            log.info(
                    "First-run setup is pending: the seeded admin no longer accepts the development password until "
                            + "/setup completes; {} refresh token(s) revoked.",
                    revoked);
        }
    }

    /** @return the number of refresh tokens revoked; null when nothing changed */
    private Integer lock() {
        if (!state.lockForUpdate()) {
            return null;
        }
        List<String> hashes = accounts.lockSeedPasswordHash();
        if (hashes.isEmpty()) {
            return null;
        }
        String hash = hashes.getFirst();
        if (hash == null
                || SetupAccounts.UNUSABLE_PASSWORD_HASH.equals(hash)
                || !passwordEncoder.matches(SeedAdmin.DEV_PASSWORD, hash)) {
            return null;
        }
        accounts.disableSeedPassword();
        return accounts.endAllSessions(SeedAdmin.ID);
    }
}
