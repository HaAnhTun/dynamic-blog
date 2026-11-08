package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * A backend that connects to PostgreSQL as a superuser turns any bug that reaches SQL into a file reader and a program runner on the
 * database host (COPY ... PROGRAM). On a public site that is worth one clear line at every start, with the way out; it is not worth
 * refusing to start, because every install from before the three database roles (docs/UPGRADING.md) is in that state and an upgrade
 * must never take a running site down. The template is a mock: the decision and the wording are under test, the real roles are in
 * DatabaseRoleIT.
 */
class DatabaseRoleWarningTest {

    private static final String QUERY = "SELECT rolsuper FROM pg_roles WHERE rolname = current_user";

    private final JdbcTemplate jdbc = mock(JdbcTemplate.class);
    private final ProductionMode production = mock(ProductionMode.class);
    private final Logger logger = (Logger) LoggerFactory.getLogger(DatabaseRoleWarning.class);
    private final ListAppender<ILoggingEvent> logs = new ListAppender<>();

    @BeforeEach
    void setUp() {
        logs.start();
        logger.addAppender(logs);
    }

    @AfterEach
    void tearDown() {
        logger.detachAppender(logs);
    }

    private DatabaseRoleWarning check(boolean productionRun) {
        when(production.active()).thenReturn(productionRun);
        return new DatabaseRoleWarning(jdbc, production);
    }

    private long warnings() {
        return logs.list.stream().filter(e -> e.getLevel() == Level.WARN).count();
    }

    @Test
    void a_superuser_on_a_production_run_gets_one_warning_that_names_the_way_out_and_no_credential() {
        when(jdbc.queryForObject(QUERY, Boolean.class)).thenReturn(true);

        check(true).run(new DefaultApplicationArguments());

        assertThat(warnings()).isEqualTo(1);
        String message = logs.list.getFirst().getFormattedMessage();
        assertThat(message).contains("superuser").contains("docs/UPGRADING.md").doesNotContain("password=");
    }

    @Test
    void a_superuser_never_stops_the_start() {
        when(jdbc.queryForObject(QUERY, Boolean.class)).thenReturn(true);

        assertThatCode(() -> check(true).run(new DefaultApplicationArguments())).doesNotThrowAnyException();
    }

    @Test
    void a_role_that_is_not_a_superuser_is_silent() {
        when(jdbc.queryForObject(QUERY, Boolean.class)).thenReturn(false);

        check(true).run(new DefaultApplicationArguments());

        assertThat(warnings()).isZero();
    }

    @Test
    void a_dev_machine_may_use_a_superuser_without_a_warning() {
        when(jdbc.queryForObject(QUERY, Boolean.class)).thenReturn(true);

        check(false).run(new DefaultApplicationArguments());

        assertThat(warnings()).isZero();
    }

    @Test
    void a_database_that_cannot_be_asked_is_not_a_reason_to_stop() {
        when(jdbc.queryForObject(QUERY, Boolean.class)).thenThrow(new DataAccessResourceFailureException("gone"));

        assertThatCode(() -> check(true).run(new DefaultApplicationArguments())).doesNotThrowAnyException();
        assertThat(warnings()).isZero();
    }
}
