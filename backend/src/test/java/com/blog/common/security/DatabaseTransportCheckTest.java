package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import java.sql.SQLException;
import java.util.concurrent.atomic.AtomicInteger;
import javax.sql.DataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.slf4j.LoggerFactory;
import org.springframework.boot.jdbc.autoconfigure.JdbcConnectionDetails;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;

/**
 * The link between the backend and PostgreSQL carries every password hash, session and post. pgjdbc's default {@code sslmode=prefer}
 * encrypts when the server offers it and silently falls back to plain text, and never checks who answered, so on a split
 * deployment (a managed database such as Neon or RDS, a backend on another machine) a production run must say {@code verify-full}.
 * A host on the machine itself or a single-label name on a private network (the Compose service {@code postgres}) is exempt.
 * The decision is under test here, not a database: the URLs are literals. The nested class runs the check inside a Spring context to
 * prove it fires when the data source is built, before Flyway or the connection pool can reach the server.
 */
class DatabaseTransportCheckTest {

    private final Logger logger = (Logger) LoggerFactory.getLogger(DatabaseTransportCheck.class);
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

    private void run(String jdbcUrl, boolean productionRun, boolean allowInsecure) {
        new DatabaseTransportCheck(() -> jdbcUrl, () -> productionRun, allowInsecure).verify();
    }

    private long warnings() {
        return logs.list.stream().filter(e -> e.getLevel() == Level.WARN).count();
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "jdbc:postgresql://db.example.com:5432/blog",
                "jdbc:postgresql://db.example.com:5432/blog?sslmode=prefer",
                "jdbc:postgresql://db.example.com/blog?sslmode=allow",
                "jdbc:postgresql://db.example.com/blog?sslmode=disable",
                "jdbc:postgresql://10.0.0.5:5432/blog?sslmode=prefer",
                "jdbc:postgresql://ep-cool-123.eu-central-1.aws.neon.tech/blog?user=u&password=hunter2",
                "jdbc:postgresql://postgres:5432,db.example.com:5432/blog?sslmode=prefer"
            })
    void a_remote_database_without_verification_stops_a_production_start(String url) {
        assertThatThrownBy(() -> run(url, true, false))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("DB_SSLMODE")
                .hasMessageContaining("verify-full")
                // pgjdbc has no fallback to the JVM trust store: without a root certificate file, or this factory,
                // verify-full cannot
                // connect, so the message has to name both ways.
                .hasMessageContaining("sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory")
                .hasMessageContaining("sslrootcert")
                .hasMessageNotContaining("hunter2")
                .hasMessageNotContaining("user=");
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                // DB_SSLMODE=verify-full followed by DB_JDBC_PARAMS=&sslmode=disable: pgjdbc connects with the last
                // one.
                "jdbc:postgresql://db.example.com:5432/blog?sslmode=verify-full&sslmode=disable",
                "jdbc:postgresql://db.example.com:5432/blog?sslmode=verify-full&sslmode=prefer",
                // verify-full names the server, but a factory that accepts any certificate lets whoever sits on the
                // path answer.
                "jdbc:postgresql://db.example.com:5432/blog?sslmode=verify-full&sslfactory=org.postgresql.ssl.NonValidatingFactory",
                "jdbc:postgresql://db.example.com:5432/blog?sslmode=verify-ca&sslfactory=org.postgresql.ssl.NonValidatingFactory",
                "jdbc:postgresql://db.example.com:5432/blog?sslmode=verify-full&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory"
                        + "&sslfactory=org.postgresql.ssl.NonValidatingFactory"
            })
    void a_later_parameter_or_a_factory_that_trusts_everything_undoes_verify_full(String url) {
        assertThatThrownBy(() -> run(url, true, false))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("DB_SSLMODE");
    }

    @Test
    void the_message_names_the_host_and_nothing_else_of_the_url() {
        assertThatThrownBy(() -> run("jdbc:postgresql://db.example.com:5432/blog?user=u&password=hunter2", true, false))
                .hasMessageContaining("db.example.com")
                .hasMessageNotContaining("hunter2")
                .hasMessageNotContaining("/blog");
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "jdbc:postgresql://db.example.com:5432/blog?sslmode=verify-full",
                "jdbc:postgresql://db.example.com:5432/blog?sslmode=verify-full&sslrootcert=/certs/ca.pem",
                "jdbc:postgresql://db.example.com:5432/blog?sslrootcert=/certs/ca.pem&sslmode=verify-full",
                "jdbc:postgresql://db.example.com:5432/blog?sslmode=verify-full&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory",
                // The last value of a repeated parameter wins, in pgjdbc and in the check.
                "jdbc:postgresql://db.example.com:5432/blog?sslmode=disable&sslmode=verify-full",
                "jdbc:postgresql://db.example.com:5432/blog?sslmode=verify-full&sslfactory=org.postgresql.ssl.NonValidatingFactory"
                        + "&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory"
            })
    void verify_full_is_accepted_for_a_remote_database(String url) {
        assertThatCode(() -> run(url, true, false)).doesNotThrowAnyException();
        assertThat(warnings()).isZero();
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "jdbc:postgresql://postgres:5432/blog?sslmode=prefer",
                "jdbc:postgresql://postgres:5432/blog",
                "jdbc:postgresql://localhost:5432/blog",
                "jdbc:postgresql://127.0.0.1:15433/blog?sslmode=disable",
                "jdbc:postgresql://[::1]:5432/blog"
            })
    void the_machine_itself_and_a_private_service_name_need_no_tls(String url) {
        assertThatCode(() -> run(url, true, false)).doesNotThrowAnyException();
        assertThat(warnings()).isZero();
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "jdbc:postgresql://db.example.com:5432/blog?sslmode=require",
                "jdbc:postgresql://db.example.com:5432/blog?sslmode=verify-ca"
            })
    void require_and_verify_ca_encrypt_but_do_not_prove_who_answers_so_they_warn_once(String url) {
        assertThatCode(() -> run(url, true, false)).doesNotThrowAnyException();
        assertThat(warnings()).isEqualTo(1);
        assertThat(logs.list.getFirst().getFormattedMessage())
                .contains("verify-full")
                .contains("sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory")
                .contains("sslrootcert")
                .doesNotContain("password");
    }

    @Test
    void the_operator_can_accept_plain_text_on_a_network_he_trusts_with_one_warning() {
        assertThatCode(() -> run("jdbc:postgresql://10.0.0.5:5432/blog", true, true))
                .doesNotThrowAnyException();
        assertThat(warnings()).isEqualTo(1);
        assertThat(logs.list.getFirst().getFormattedMessage()).contains("DB_ALLOW_INSECURE_TRANSPORT");
    }

    @Test
    void a_dev_machine_is_not_checked() {
        assertThatCode(() -> run("jdbc:postgresql://db.example.com:5432/blog", false, false))
                .doesNotThrowAnyException();
        assertThat(warnings()).isZero();
    }

    @Test
    void a_url_that_cannot_be_read_is_not_a_reason_to_guess() {
        assertThatThrownBy(() -> run("jdbc:postgresql:blog", true, false)).isInstanceOf(IllegalStateException.class);
    }

    /** Counts the beans that ask the data source for a connection while the context is built. */
    static final AtomicInteger CONNECTIONS_ASKED = new AtomicInteger();

    /** What Flyway and Hibernate do: ask the data source for a connection as soon as they are built. */
    static class Dependent {
        Dependent(DataSource dataSource) {
            CONNECTIONS_ASKED.incrementAndGet();
            try {
                dataSource.getConnection();
            } catch (SQLException e) {
                throw new IllegalStateException(e);
            }
        }
    }

    /**
     * The point of the check is that the link is never opened over an unverified setting. Flyway and the connection pool connect while
     * the Spring context is built, long before an ApplicationRunner runs, so the check has to fire when the data source bean is created.
     */
    @Nested
    class InsideTheContext {

        @BeforeEach
        void reset() {
            CONNECTIONS_ASKED.set(0);
        }

        private ApplicationContextRunner contextFor(String jdbcUrl, DataSource dataSource) {
            JdbcConnectionDetails details = mock(JdbcConnectionDetails.class);
            when(details.getJdbcUrl()).thenReturn(jdbcUrl);
            ProductionMode production = mock(ProductionMode.class);
            when(production.active()).thenReturn(true);
            return new ApplicationContextRunner()
                    .withBean(Dependent.class)
                    .withBean(JdbcConnectionDetails.class, () -> details)
                    .withBean(ProductionMode.class, () -> production)
                    .withBean(DataSource.class, () -> dataSource)
                    .withBean(DatabaseTransportCheck.class);
        }

        private static String rootMessage(Throwable failure) {
            Throwable root = failure;
            while (root.getCause() != null) {
                root = root.getCause();
            }
            return root.getMessage();
        }

        @Test
        void an_unverified_remote_database_stops_the_start_before_anything_asks_for_a_connection() throws SQLException {
            DataSource dataSource = mock(DataSource.class);

            contextFor("jdbc:postgresql://db.example.com:5432/blog", dataSource).run(context -> {
                assertThat(context).hasFailed();
                assertThat(rootMessage(context.getStartupFailure()))
                        .contains("DB_SSLMODE")
                        .contains("db.example.com");
            });

            verify(dataSource, never()).getConnection();
            assertThat(CONNECTIONS_ASKED).hasValue(0);
        }

        @Test
        void a_verified_link_starts_as_usual_and_connects() throws SQLException {
            DataSource dataSource = mock(DataSource.class);

            contextFor("jdbc:postgresql://db.example.com:5432/blog?sslmode=verify-full", dataSource)
                    .run(context -> assertThat(context).hasNotFailed());

            verify(dataSource).getConnection();
            assertThat(CONNECTIONS_ASKED).hasValue(1);
        }

        @Test
        void an_operator_who_accepts_plain_text_on_purpose_starts() {
            contextFor("jdbc:postgresql://10.0.0.5:5432/blog", mock(DataSource.class))
                    .withPropertyValues("app.database.allow-insecure-transport=true")
                    .run(context -> assertThat(context).hasNotFailed());
        }
    }
}
