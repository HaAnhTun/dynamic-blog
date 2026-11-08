package com.blog.auth.service;

import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Component;

/**
 * Brings the enrollment code file in step with the accounts at startup ({@link MfaEnrollmentCodeService#reconcile()}).
 * {@code @Order(18)}: after {@code MfaOperatorReset} (17), so it sees the state the reset leaves behind, and after the
 * setup runners and {@code SetupCompletionFromEnvironment} (16), so a fresh install in setup is recognised.
 *
 * It never breaks startup: a database error is one WARN line with the class name.
 */
@Component
@Order(18)
@RequiredArgsConstructor
public class MfaEnrollmentCodeRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(MfaEnrollmentCodeRunner.class);

    private final MfaEnrollmentCodeService codes;

    @Override
    public void run(ApplicationArguments args) {
        try {
            codes.reconcile();
        } catch (DataAccessException e) {
            log.warn(
                    "mfa enrollment code state could not be checked: {}",
                    e.getClass().getName());
        }
    }
}
