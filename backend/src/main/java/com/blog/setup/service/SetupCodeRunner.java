package com.blog.setup.service;

import java.io.IOException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Component;

/**
 * Makes sure the setup code exists while setup is required, as early as possible ({@code @Order(2)}, before
 * AdminSeedEmail), and removes a leftover code file once setup is completed.
 *
 * It logs where the code is and how to read it, never the code. If the file cannot be written it logs the path and the
 * reason at ERROR and startup continues: without a code nobody can claim the instance (fail closed), the site itself
 * keeps running, and the operator fixes the directory or sets {@code SETUP_TOKEN}.
 */
@Component
@Order(2)
public class SetupCodeRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(SetupCodeRunner.class);

    private final SetupState state;
    private final SetupCodeStore codeStore;

    public SetupCodeRunner(SetupState state, SetupCodeStore codeStore) {
        this.state = state;
        this.codeStore = codeStore;
    }

    @Override
    public void run(ApplicationArguments args) {
        boolean required;
        try {
            required = state.isRequired();
        } catch (DataAccessException e) {
            log.warn("first-run setup state could not be read: {}", e.getClass().getName());
            return;
        }
        if (!required || codeStore.usesToken()) {
            // A leftover file never works once setup is completed, nor while SETUP_TOKEN is the code.
            codeStore.discard();
        }
        if (!required) {
            return;
        }
        if (codeStore.usesToken()) {
            log.info("First-run setup is open: enter the value of SETUP_TOKEN as the setup code at /setup.");
            return;
        }
        try {
            codeStore.ensureFile();
        } catch (IOException | RuntimeException e) {
            log.error(
                    "First-run setup code could not be written to {} ({}: {}). Nobody can claim this instance until "
                            + "SETUP_DATA_DIR is writable or SETUP_TOKEN is set; restart afterwards.",
                    codeStore.file(),
                    e.getClass().getSimpleName(),
                    e.getMessage());
            return;
        }
        log.info(
                "First-run setup is open. The setup code is in {} on the server (read it with: cat {}); enter it at "
                        + "/setup. The file is deleted when setup completes.",
                codeStore.file(),
                codeStore.file());
    }
}
