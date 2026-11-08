package com.blog.common.database;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Map;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.testcontainers.containers.Container.ExecResult;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.MountableFile;

/**
 * The database roles of a Compose install (deploy/postgres-init): the bootstrap superuser is for administration only, a
 * NOSUPERUSER owner role runs the Flyway migrations, and the backend itself connects as a third role that can read and write
 * rows and nothing else. A bug that reaches SQL (an injection, a deserialization gadget) then cannot create objects, install
 * extensions, read files of the database host or run programs there.
 *
 * Two paths, both against the real init script and the real migrations: a fresh install (the script runs when the container
 * creates its data directory, as in Compose) and an existing single-role install that is moved to the three roles later by
 * running {@code roles.psql} by hand (docs/UPGRADING.md), which must also transfer the ownership of what the old role created.
 */
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class DatabaseRoleIT {

    private static final Path INIT_DIR =
            Path.of("..", "deploy", "postgres-init").toAbsolutePath().normalize();
    private static final String ADMIN = "blog_admin";
    private static final String ADMIN_PASSWORD = "admin-password-for-the-it";
    private static final String OWNER = "blog_owner";
    private static final String OWNER_PASSWORD = "owner-password-for-the-it";
    private static final String APP = "blog_app";
    private static final String APP_PASSWORD = "app-password-for-the-it";

    @SuppressWarnings("resource")
    private static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:18")
            .withUsername(ADMIN)
            .withPassword(ADMIN_PASSWORD)
            .withDatabaseName("blog")
            .withEnv("APP_DB_USER", APP)
            .withEnv("APP_DB_PASSWORD", APP_PASSWORD)
            .withEnv("OWNER_DB_USER", OWNER)
            .withEnv("OWNER_DB_PASSWORD", OWNER_PASSWORD)
            .withCopyFileToContainer(
                    MountableFile.forHostPath(INIT_DIR.resolve("10-roles.sh"), 0755),
                    "/docker-entrypoint-initdb.d/10-roles.sh")
            .withCopyFileToContainer(
                    MountableFile.forHostPath(INIT_DIR.resolve("roles.psql")),
                    "/docker-entrypoint-initdb.d/roles.psql");

    @BeforeAll
    static void start() {
        POSTGRES.start();
        migrate("blog", OWNER, OWNER_PASSWORD);
    }

    @AfterAll
    static void stop() {
        POSTGRES.stop();
    }

    private static String url(String database) {
        return "jdbc:postgresql://" + POSTGRES.getHost() + ":" + POSTGRES.getMappedPort(5432) + "/" + database;
    }

    private static Connection connect(String database, String user, String password) throws SQLException {
        return DriverManager.getConnection(url(database), user, password);
    }

    private static void migrate(String database, String user, String password) {
        Flyway.configure()
                .dataSource(url(database), user, password)
                .locations("classpath:db/migration")
                .placeholders(Map.of("defaultLocale", "en"))
                .load()
                .migrate();
    }

    private static String scalar(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
                ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getString(1);
        }
    }

    private static void execute(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.execute(sql);
        }
    }

    // ---------------------------------------------------------------- a fresh install

    @Test
    @Order(1)
    void the_runtime_role_has_no_dangerous_attribute() throws SQLException {
        try (Connection app = connect("blog", APP, APP_PASSWORD)) {
            assertThat(scalar(
                            app,
                            "SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls "
                                    + "FROM pg_roles WHERE rolname = current_user"))
                    .isEqualTo("f");
            assertThat(scalar(app, "SELECT current_user")).isEqualTo(APP);
        }
    }

    @Test
    @Order(2)
    void the_owner_role_is_not_a_superuser_and_the_migrations_ran_with_it() throws SQLException {
        try (Connection owner = connect("blog", OWNER, OWNER_PASSWORD)) {
            assertThat(scalar(owner, "SELECT rolsuper FROM pg_roles WHERE rolname = current_user"))
                    .isEqualTo("f");
            // CREATE EXTENSION unaccent (V23) worked without a superuser: the extension is trusted and the owner owns
            // the database.
            assertThat(scalar(owner, "SELECT count(*) FROM pg_extension WHERE extname = 'unaccent'"))
                    .isEqualTo("1");
            assertThat(scalar(owner, "SELECT count(*) FROM flyway_schema_history WHERE NOT success"))
                    .isEqualTo("0");
            assertThat(scalar(owner, "SELECT DISTINCT tableowner FROM pg_tables WHERE tablename = 'posts'"))
                    .isEqualTo(OWNER);
        }
    }

    @Test
    @Order(3)
    void the_runtime_role_reads_and_writes_rows_of_tables_the_owner_created() throws SQLException {
        try (Connection app = connect("blog", APP, APP_PASSWORD)) {
            assertThat(scalar(app, "SELECT count(*) FROM users")).isEqualTo("1");
            // The search vector of a post is generated with the unaccent extension, which the owner installed: the
            // runtime role can call it.
            assertThat(scalar(app, "SELECT unaccent('Caf\u00e9')")).isEqualTo("Cafe");
            execute(
                    app,
                    "INSERT INTO categories (id, name, slug) VALUES (gen_random_uuid(), 'Role test', 'role-test')");
            execute(app, "UPDATE categories SET name = 'Role test 2' WHERE slug = 'role-test'");
            assertThat(scalar(app, "SELECT name FROM categories WHERE slug = 'role-test'"))
                    .isEqualTo("Role test 2");
            execute(app, "DELETE FROM categories WHERE slug = 'role-test'");
        }
    }

    @Test
    @Order(4)
    void tables_and_sequences_created_by_a_later_migration_are_usable_without_a_new_grant() throws SQLException {
        try (Connection owner = connect("blog", OWNER, OWNER_PASSWORD);
                Connection app = connect("blog", APP, APP_PASSWORD)) {
            execute(owner, "CREATE TABLE later_table (id serial PRIMARY KEY, label text)");
            execute(app, "INSERT INTO later_table (label) VALUES ('from the runtime role')");
            assertThat(scalar(app, "SELECT nextval('later_table_id_seq')")).isEqualTo("2");
            execute(owner, "DROP TABLE later_table");
        }
    }

    @Test
    @Order(5)
    void the_runtime_role_cannot_change_the_schema() throws SQLException {
        try (Connection app = connect("blog", APP, APP_PASSWORD)) {
            for (String ddl : new String[] {
                "CREATE TABLE intruder (i int)",
                "DROP TABLE categories",
                "ALTER TABLE categories ADD COLUMN intruder int",
                "CREATE EXTENSION IF NOT EXISTS pg_trgm",
                "CREATE FUNCTION intruder() RETURNS int LANGUAGE sql AS 'SELECT 1'",
                "CREATE SCHEMA intruder",
                "TRUNCATE categories",
                "CREATE ROLE intruder",
                "DROP DATABASE blog"
            }) {
                assertThatThrownBy(() -> execute(app, ddl))
                        .as(ddl)
                        .isInstanceOf(SQLException.class)
                        .hasMessageContaining("ERROR");
            }
        }
    }

    @Test
    @Order(6)
    void the_runtime_role_cannot_reach_the_host_of_the_database() throws SQLException {
        try (Connection app = connect("blog", APP, APP_PASSWORD)) {
            for (String sql : new String[] {
                "COPY (SELECT 1) TO PROGRAM 'id'",
                "SELECT pg_read_file('/etc/passwd')",
                "SELECT pg_ls_dir('/')",
                "COPY categories FROM '/etc/passwd'",
                "ALTER SYSTEM SET work_mem = '1GB'"
            }) {
                assertThatThrownBy(() -> execute(app, sql))
                        .as(sql)
                        .isInstanceOf(SQLException.class)
                        .hasMessageContaining("ERROR");
            }
        }
    }

    @Test
    @Order(7)
    void the_database_is_closed_to_everyone_but_its_two_roles() throws SQLException {
        try (Connection admin = connect("postgres", ADMIN, ADMIN_PASSWORD)) {
            execute(admin, "CREATE ROLE stranger LOGIN PASSWORD 'stranger-password'");
        }
        assertThatThrownBy(
                        () -> connect("blog", "stranger", "stranger-password").close())
                .isInstanceOf(SQLException.class)
                .hasMessageContaining("permission denied");
    }

    @Test
    @Order(8)
    void running_the_script_again_is_harmless_and_rotates_the_passwords() throws Exception {
        ExecResult again = roles("blog", APP, "rotated-" + APP_PASSWORD, OWNER, OWNER_PASSWORD);
        assertThat(again.getExitCode()).as(again.getStderr()).isZero();
        try (Connection app = connect("blog", APP, "rotated-" + APP_PASSWORD)) {
            assertThat(scalar(app, "SELECT count(*) FROM users")).isEqualTo("1");
        }
        roles("blog", APP, APP_PASSWORD, OWNER, OWNER_PASSWORD);
    }

    @Test
    @Order(9)
    void the_script_refuses_an_incomplete_or_dangerous_configuration() throws Exception {
        for (String[] names : new String[][] {
            {"", APP_PASSWORD, OWNER, OWNER_PASSWORD},
            {APP, "", OWNER, OWNER_PASSWORD},
            {APP, APP_PASSWORD, "", OWNER_PASSWORD},
            {APP, APP_PASSWORD, OWNER, ""},
            {APP, APP_PASSWORD, APP, OWNER_PASSWORD},
            {ADMIN, APP_PASSWORD, OWNER, OWNER_PASSWORD},
            {APP, APP_PASSWORD, ADMIN, OWNER_PASSWORD},
            // One password for two roles: the runtime and the owner role, or the superuser (POSTGRES_PASSWORD of the
            // container)
            // and either of them.
            {APP, OWNER_PASSWORD, OWNER, OWNER_PASSWORD},
            {APP, ADMIN_PASSWORD, OWNER, OWNER_PASSWORD},
            {APP, APP_PASSWORD, OWNER, ADMIN_PASSWORD}
        }) {
            ExecResult result = roles("blog", names[0], names[1], names[2], names[3]);
            assertThat(result.getExitCode()).as(String.join("|", names)).isNotZero();
            assertThat(result.getStderr() + result.getStdout())
                    .as("the passwords are never echoed")
                    .doesNotContain(APP_PASSWORD, OWNER_PASSWORD, ADMIN_PASSWORD);
        }
    }

    // ---------------------------------------------------------------- an existing single-role install

    @Test
    @Order(10)
    void an_existing_install_moves_to_the_three_roles_without_losing_anything() throws Exception {
        try (Connection admin = connect("postgres", ADMIN, ADMIN_PASSWORD)) {
            execute(admin, "CREATE DATABASE legacy");
        }
        // The old way: the superuser migrates and owns everything, including a table full of data.
        migrate("legacy", ADMIN, ADMIN_PASSWORD);
        try (Connection admin = connect("legacy", ADMIN, ADMIN_PASSWORD)) {
            execute(admin, "INSERT INTO categories (id, name, slug) VALUES (gen_random_uuid(), 'Old category', 'old')");
            assertThat(scalar(admin, "SELECT DISTINCT tableowner FROM pg_tables WHERE tablename = 'posts'"))
                    .isEqualTo(ADMIN);
        }

        ExecResult upgraded = roles("legacy", "legacy_app", "legacy-app-pw", "legacy_owner", "legacy-owner-pw");
        assertThat(upgraded.getExitCode()).as(upgraded.getStderr()).isZero();

        try (Connection owner = connect("legacy", "legacy_owner", "legacy-owner-pw")) {
            assertThat(scalar(owner, "SELECT count(DISTINCT tableowner) FROM pg_tables WHERE schemaname = 'public'"))
                    .isEqualTo("1");
            assertThat(scalar(owner, "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'"))
                    .isEqualTo("legacy_owner");
            assertThat(
                            scalar(
                                    owner,
                                    "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace "
                                            + "WHERE n.nspname = 'public' AND p.proowner <> 'legacy_owner'::regrole "
                                            + "AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')"))
                    .isEqualTo("0");
            assertThat(scalar(
                            owner,
                            "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                                    + "WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S', 'v', 'm') "
                                    + "AND c.relowner <> 'legacy_owner'::regrole"))
                    .isEqualTo("0");
        }
        // Flyway checks the checksums and the history as the new owner, and a migration that is not there yet can be
        // applied.
        Flyway flyway = Flyway.configure()
                .dataSource(url("legacy"), "legacy_owner", "legacy-owner-pw")
                .locations("classpath:db/migration")
                .placeholders(Map.of("defaultLocale", "en"))
                .load();
        flyway.validate();
        assertThat(flyway.migrate().migrationsExecuted).isZero();

        try (Connection app = connect("legacy", "legacy_app", "legacy-app-pw")) {
            assertThat(scalar(app, "SELECT name FROM categories WHERE slug = 'old'"))
                    .isEqualTo("Old category");
            execute(app, "INSERT INTO categories (id, name, slug) VALUES (gen_random_uuid(), 'New category', 'new')");
            assertThatThrownBy(() -> execute(app, "CREATE TABLE intruder (i int)"))
                    .isInstanceOf(SQLException.class);
            assertThatThrownBy(() -> execute(app, "DROP TABLE categories")).isInstanceOf(SQLException.class);
        }
        // The old role still exists for administration, and the roles the script made are the only way in besides it.
        try (Connection admin = connect("legacy", ADMIN, ADMIN_PASSWORD)) {
            assertThat(scalar(admin, "SELECT count(*) FROM categories")).isEqualTo("2");
        }
    }

    /** Runs {@code roles.psql} in a database of the container, the way docs/UPGRADING.md tells an operator to. */
    private static ExecResult roles(
            String database, String appUser, String appPassword, String ownerUser, String ownerPassword)
            throws Exception {
        String command =
                "APP_DB_USER='" + appUser + "' APP_DB_PASSWORD='" + appPassword + "' OWNER_DB_USER='" + ownerUser
                        + "' OWNER_DB_PASSWORD='" + ownerPassword + "' psql -U " + ADMIN + " -d " + database
                        + " -X -q -v ON_ERROR_STOP=1 -f /docker-entrypoint-initdb.d/roles.psql";
        return POSTGRES.execInContainer("sh", "-c", command);
    }
}
