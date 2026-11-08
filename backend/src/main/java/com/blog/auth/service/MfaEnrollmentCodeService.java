package com.blog.auth.service;

import com.blog.common.security.ProductionMode;
import com.blog.setup.service.SetupState;
import java.io.IOException;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Decides when the operator's enrollment code ({@link MfaEnrollmentCodeStore}) has to exist, and keeps the file in step:
 * <ul>
 *   <li>at startup ({@code MfaEnrollmentCodeRunner}): created when at least one ADMIN has no confirmed enrollment and no open
 *       enrollment window, and the first-run setup is not pending (a fresh install in setup prints one code, the setup code,
 *       not two: the claim opens the window for the first sign-in); deleted when no such ADMIN remains;</li>
 *   <li>when an ENROLL challenge is issued while the window is closed and no code exists (a promotion to ADMIN at runtime
 *       has no file until the next restart): created on the spot;</li>
 *   <li>after each successful confirm: deleted, or replaced by a new random value when another ADMIN is still pending.</li>
 * </ul>
 * With {@code MFA_ENROLLMENT_TOKEN} the operator's own value is the code: nothing is created or rotated.
 *
 * Nothing here logs the code; the log line names the path and the command to read it.
 */
@Service
@RequiredArgsConstructor
public class MfaEnrollmentCodeService {

    private static final Logger log = LoggerFactory.getLogger(MfaEnrollmentCodeService.class);

    private final MfaEnrollmentCodeStore store;
    private final ProductionMode productionMode;
    private final SetupState setupState;
    private final JdbcTemplate jdbcTemplate;

    /** Whether {@code candidate} is the enrollment code. */
    public boolean matches(String candidate) {
        return store.matches(candidate);
    }

    /**
     * How many active ADMIN accounts have neither a confirmed authenticator nor an open enrollment window. On an opted-in
     * development run the window is open for everyone, so there are none.
     */
    public long pendingAdmins() {
        if (!productionMode.active()) {
            return 0;
        }
        Long count = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM users u WHERE u.role = 'ADMIN' AND u.status = 'ACTIVE' "
                        + "AND NOT EXISTS (SELECT 1 FROM user_mfa m WHERE m.user_id = u.id AND m.status = 'ACTIVE') "
                        + "AND (u.mfa_enrollment_open_until IS NULL OR u.mfa_enrollment_open_until <= now())",
                Long.class);
        return count == null ? 0 : count;
    }

    /** Startup: bring the file in step with the accounts. Never throws: a failure is logged and the site keeps running. */
    public void reconcile() {
        if (pendingAdmins() == 0 || setupState.isRequired()) {
            if (!store.usesToken()) {
                store.discard();
            }
            return;
        }
        if (store.usesToken()) {
            log.warn("An administrator must set up two-step verification. The enrollment code is the value of "
                    + "MFA_ENROLLMENT_TOKEN; remove it from the environment once the enrollment is done.");
            return;
        }
        createFile();
    }

    /** An ENROLL challenge was issued with a closed window: make sure there is a code to ask for. */
    public void ensureForPendingAdmin() {
        if (!store.usesToken() && !store.fileExists()) {
            createFile();
        }
    }

    /** After a confirm has committed: delete the file, or replace the code when another administrator is still pending. */
    public void afterConfirm() {
        if (store.usesToken() || !store.fileExists()) {
            return;
        }
        if (pendingAdmins() == 0) {
            store.discard();
            return;
        }
        try {
            store.regenerate();
            log.info(
                    "mfa enrollment code replaced: another administrator is still pending, read the new code in {}",
                    store.file());
        } catch (IOException | RuntimeException e) {
            log.error(
                    "mfa enrollment code could not be replaced in {} ({})",
                    store.file(),
                    e.getClass().getSimpleName());
        }
    }

    private void createFile() {
        try {
            if (store.ensureFile()) {
                log.warn(
                        "An administrator must set up two-step verification. The enrollment code is in {} on the server "
                                + "(read it with: cat {}); enter it once on the enrollment page. The file is deleted when "
                                + "no administrator is pending.",
                        store.file(),
                        store.file());
            }
        } catch (IOException | RuntimeException e) {
            log.error(
                    "The mfa enrollment code could not be written to {} ({}: {}). Nobody can enrol until the data "
                            + "directory is writable or MFA_ENROLLMENT_TOKEN is set; restart afterwards.",
                    store.file(),
                    e.getClass().getSimpleName(),
                    e.getMessage());
        }
    }
}
