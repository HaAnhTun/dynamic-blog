package com.blog.setup.service;

import com.blog.common.security.AdminAccountProperties;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionException;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Closes first-run setup when the operator already claimed the instance through the environment: the admin row of
 * {@code ADMIN_EMAIL} accepts {@code ADMIN_PASSWORD} (AdminPasswordFromEnvironment applied it), or an ADMIN carries
 * {@code ADMIN_GITHUB_ID} (AdminGithubLink linked it). Then the code file is deleted.
 *
 * It checks the result in the database rather than trusting the variables: a password that could not be applied (no
 * such admin) or a link that was refused leaves setup open. {@code @Order(16)}: right after AdminGithubLink (15). Never
 * breaks startup: a database error is one WARN line and setup stays as it was.
 */
@Component
@Order(16)
public class SetupCompletionFromEnvironment implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(SetupCompletionFromEnvironment.class);

    private final String adminEmail;
    private final String adminPassword;
    private final Long githubId;
    private final SetupState state;
    private final SetupCodeStore codeStore;
    private final JdbcTemplate jdbcTemplate;
    private final PasswordEncoder passwordEncoder;
    private final TransactionTemplate transactionTemplate;

    public SetupCompletionFromEnvironment(
            AdminAccountProperties admin,
            SetupState state,
            SetupCodeStore codeStore,
            JdbcTemplate jdbcTemplate,
            PasswordEncoder passwordEncoder,
            PlatformTransactionManager transactionManager) {
        this.adminEmail = admin.email();
        this.adminPassword = admin.password() == null || admin.password().isBlank() ? null : admin.password();
        this.githubId = admin.linkedGithubId();
        this.state = state;
        this.codeStore = codeStore;
        this.jdbcTemplate = jdbcTemplate;
        this.passwordEncoder = passwordEncoder;
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    @Override
    public void run(ApplicationArguments args) {
        if (adminPassword == null && githubId == null) {
            return;
        }
        Boolean closed;
        try {
            closed = transactionTemplate.execute(status -> close());
        } catch (DataAccessException | TransactionException e) {
            log.warn(
                    "first-run setup state not updated from the environment: {}",
                    e.getClass().getName());
            return;
        }
        if (Boolean.TRUE.equals(closed)) {
            codeStore.discard();
            log.info("First-run setup closed: the admin account was configured through the environment "
                    + "(ADMIN_PASSWORD or ADMIN_GITHUB_ID).");
        }
    }

    private boolean close() {
        if (!state.lockForUpdate()) {
            return false;
        }
        if (!githubLinked() && !passwordApplied()) {
            return false;
        }
        state.markCompleted();
        return true;
    }

    private boolean githubLinked() {
        return githubId != null
                && Boolean.TRUE.equals(jdbcTemplate.queryForObject(
                        "SELECT EXISTS (SELECT 1 FROM users WHERE github_id = ? AND role = 'ADMIN')",
                        Boolean.class,
                        githubId));
    }

    private boolean passwordApplied() {
        if (adminPassword == null || adminEmail == null || adminEmail.isBlank()) {
            return false;
        }
        List<String> hashes = jdbcTemplate.queryForList(
                "SELECT password_hash FROM users WHERE email = ? AND role = 'ADMIN'", String.class, adminEmail);
        if (hashes.isEmpty()) {
            return false;
        }
        String hash = hashes.getFirst();
        return hash != null
                && !SetupAccounts.UNUSABLE_PASSWORD_HASH.equals(hash)
                && passwordEncoder.matches(adminPassword, hash);
    }
}
