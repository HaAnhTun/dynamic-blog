package com.blog.support;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import org.testcontainers.postgresql.PostgreSQLContainer;

/**
 * GitHub login is ON in every IT, pointed at {@link GithubStub}, and the seeded admin is linked to
 * {@link GithubStub#ADMIN_GITHUB_ID}: the whole suite runs with the configuration closest to production, on one
 * shared context.
 *
 * Fixed values live in {@code @TestPropertySource}, not in {@code @DynamicPropertySource}: dynamic properties win
 * over every {@code @TestPropertySource}, including a subclass's, so GithubOAuthDisabledIT could not turn OAuth off
 * if the client id were set there. Only the three addresses of the fake server (random port) are dynamic.
 *
 * Swagger UI and /v3/api-docs are ON here, although application.yml defaults to off: OpenApiConfigIT compares the
 * document with the real response, and SecurityMatrixIT calls both paths. The off branch has its own context,
 * SpringDocDisabledIT. {@code SITE_URL} is left empty, even when the machine running the tests has that variable:
 * every IT runs like a dev machine (ProductionMode), with the dev JWT secret and admin password. The fake GitHub
 * callback is already in redirect-uri.
 *
 * The refresh-token cleanup schedule is OFF here (cron {@code -}): at exactly 03:17 in the middle of the suite it
 * would delete an expired token that a test just created to check REFRESH_TOKEN_EXPIRED. RefreshTokenCleanupIT calls
 * the bean directly; the cron wiring is checked separately, without a DB, in RefreshTokenCleanupConfigTest.
 *
 * The newsletter worker is also OFF: running on schedule mid-suite it would split issues and send other classes' mail
 * at a time nobody can predict. NewsletterIT calls the bean directly; the schedule wiring is checked in
 * NewsletterConfigTest.
 *
 * The search outbox worker and the reconcile schedule (cron {@code -}) are OFF for the same reason, and
 * {@code MEILI_URL} is empty even when the machine has that variable: indexing is off here (SearchOutboxDisabledIT);
 * the Meilisearch ITs have their own context (MeiliIntegrationTest).
 *
 * First-run setup: {@code app.setup.lock-dev-seed} is OFF because several classes sign in with the seeded admin's dev
 * password (the setup ITs, on databases of their own, turn it on); the setup code file goes to a temporary directory,
 * never into the working tree. The ADMIN_GITHUB_ID link above closes setup at startup anyway.
 */
@SpringBootTest
@Import(AuthTestSupport.class)
@TestPropertySource(
        properties = {
            "app.oauth.github.client-id=" + GithubStub.CLIENT_ID,
            "app.oauth.github.client-secret=" + GithubStub.CLIENT_SECRET,
            "app.oauth.github.redirect-uri=" + GithubStub.REDIRECT_URI,
            "app.oauth.github.site-url=",
            "app.admin.github-id=" + GithubStub.ADMIN_GITHUB_ID,
            "springdoc.api-docs.enabled=true",
            "springdoc.swagger-ui.enabled=true",
            "app.security.refresh-token-cleanup-cron=-",
            "app.contact.retention.cron=-",
            "app.newsletter.worker-enabled=false",
            "app.search.worker-enabled=false",
            "app.search.reconcile-cron=-",
            "app.search.meili.url=",
            "app.setup.token=",
            "app.setup.lock-dev-seed=false",
            "app.setup.data-dir=${java.io.tmpdir}/blog-it-setup"
        })
public abstract class AbstractIntegrationTest {

    // Started once per JVM instead of via @Testcontainers/@Container, whose per-class lifecycle stops the container
    // between test classes and strands Spring's cached contexts on a port nothing listens on any more. Ryuk removes
    // it at JVM exit. max_connections: every cached context (the shared context, the ITs with their own DB) keeps a
    // Hikari pool until the JVM ends; the default of 100 runs out when the suite has more contexts, and the next DB
    // creation gets "too many clients".
    @ServiceConnection
    static final PostgreSQLContainer postgres =
            new PostgreSQLContainer("postgres:18").withCommand("postgres", "-c", "max_connections=300");

    /** One fake GitHub for the whole JVM, same reason as the container: a cached context keeps its address. */
    protected static final GithubStub GITHUB = GithubStub.start();

    static {
        postgres.start();
    }

    @DynamicPropertySource
    static void githubStubAddresses(DynamicPropertyRegistry registry) {
        registry.add("app.oauth.github.provider.authorization-uri", GITHUB::authorizationUri);
        registry.add("app.oauth.github.provider.token-uri", GITHUB::tokenUri);
        registry.add("app.oauth.github.provider.user-info-uri", GITHUB::userInfoUri);
    }

    /**
     * Points an IT's context at a freshly created database in this very container: Flyway migrates it from scratch,
     * so only the seeded admin exists, and no other class touches it (LastAdminIT). That class does not extend this
     * one: the {@code @ServiceConnection} above would win over {@code spring.datasource.*}.
     */
    public static void useFreshDatabase(DynamicPropertyRegistry registry, String database) {
        String url = createDatabase(database);
        registry.add("spring.datasource.url", () -> url);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
    }

    /**
     * A freshly created database in this very container, not migrated at all and with no Spring context: lets a test
     * run Flyway up to one version itself, write old data, and only then run the migration under test
     * (UserPublicSlugMigrationIT).
     */
    public static DriverManagerDataSource freshDataSource(String database) {
        return new DriverManagerDataSource(createDatabase(database), postgres.getUsername(), postgres.getPassword());
    }

    private static String createDatabase(String database) {
        try (Connection connection = DriverManager.getConnection(
                        postgres.getJdbcUrl(), postgres.getUsername(), postgres.getPassword());
                Statement statement = connection.createStatement()) {
            statement.execute("DROP DATABASE IF EXISTS " + database + " WITH (FORCE)");
            statement.execute("CREATE DATABASE " + database);
        } catch (SQLException e) {
            throw new IllegalStateException("Could not create database " + database, e);
        }
        return "jdbc:postgresql://" + postgres.getHost() + ":" + postgres.getMappedPort(5432) + "/" + database;
    }
}
