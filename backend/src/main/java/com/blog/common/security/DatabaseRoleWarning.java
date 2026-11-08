package com.blog.common.security;

import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Says so, once per start, when a production run connects to PostgreSQL as a superuser. Such a role turns any bug that reaches SQL
 * into a file reader and a program runner on the database host ({@code COPY ... PROGRAM}, {@code pg_read_file}); the Compose
 * install since the three database roles connects as a role that can read and write rows and nothing else
 * ({@code deploy/postgres-init}, docs/SECURITY.md).
 *
 * A warning, never a refusal: every install from before the three roles is in this state, and an upgrade must not take a
 * running site down. The way out is a documented, opt-in procedure (docs/UPGRADING.md, "Moving to the three database roles").
 * A dev machine is not asked (the development database is a superuser on purpose), and a database that cannot answer is not a
 * reason to stop: the checks that need it have already run.
 */
@Component
@Order(25)
@RequiredArgsConstructor
public class DatabaseRoleWarning implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(DatabaseRoleWarning.class);

    private final JdbcTemplate jdbcTemplate;
    private final ProductionMode productionMode;

    @Override
    public void run(ApplicationArguments args) {
        if (!productionMode.active()) {
            return;
        }
        Boolean superuser;
        try {
            superuser = jdbcTemplate.queryForObject(
                    "SELECT rolsuper FROM pg_roles WHERE rolname = current_user", Boolean.class);
        } catch (DataAccessException e) {
            log.debug("database role not checked: {}", e.getClass().getName());
            return;
        }
        if (Boolean.TRUE.equals(superuser)) {
            log.warn(
                    "The backend connects to PostgreSQL as a superuser. A bug that reaches SQL could then read files and run "
                            + "programs on the database host. Use a role that can only read and write rows: docs/UPGRADING.md, "
                            + "\"Moving to the three database roles\" (a new Compose install already does).");
        }
    }
}
