package com.blog.setup;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.common.security.SeedAdmin;
import com.blog.support.AbstractIntegrationTest;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * V36 decides whether an existing database is claimable: only a provably fresh one is (nothing but the untouched seed
 * admin). Every case runs on its own database: Flyway builds it up to V35, the test writes what a running site would
 * have, and then the rest of the migrations run. No Spring context: only the migration's SQL is checked.
 */
class SetupMigrationIT {

    @Test
    void only_the_untouched_seed_on_an_empty_database_leaves_setup_required() {
        assertThat(setupCompletedAfterMigration("setup_migration_fresh_it", jdbc -> {}))
                .isFalse();
    }

    @Test
    void a_changed_seed_password_as_admin_password_leaves_it_marks_setup_completed() {
        assertThat(setupCompletedAfterMigration(
                        "setup_migration_password_it",
                        jdbc -> jdbc.update(
                                "UPDATE users SET password_hash = '$argon2id$v=19$m=16384,t=2,p=1$b3RoZXI$b3RoZXI' "
                                        + "WHERE id = ?",
                                SeedAdmin.ID)))
                .isTrue();
    }

    @Test
    void a_github_link_on_the_seed_marks_setup_completed() {
        assertThat(setupCompletedAfterMigration(
                        "setup_migration_github_it",
                        jdbc -> jdbc.update("UPDATE users SET github_id = 4242 WHERE id = ?", SeedAdmin.ID)))
                .isTrue();
    }

    @Test
    void a_renamed_seed_email_marks_setup_completed() {
        assertThat(setupCompletedAfterMigration(
                        "setup_migration_email_it",
                        jdbc -> jdbc.update(
                                "UPDATE users SET email = 'owner@example.test' WHERE id = ?", SeedAdmin.ID)))
                .isTrue();
    }

    @Test
    void any_post_marks_setup_completed() {
        assertThat(setupCompletedAfterMigration(
                        "setup_migration_post_it",
                        jdbc -> jdbc.update(
                                "INSERT INTO posts (id, title, slug, content, status, author_id) "
                                        + "VALUES (?, 'Draft', 'draft', 'body', 'DRAFT', ?)",
                                UUID.randomUUID(),
                                SeedAdmin.ID)))
                .isTrue();
    }

    @Test
    void any_category_tag_or_other_content_without_a_post_marks_setup_completed() {
        assertThat(setupCompletedAfterMigration(
                        "setup_migration_tag_it",
                        jdbc -> jdbc.update("INSERT INTO tags (name, slug) VALUES ('Java', 'java')")))
                .isTrue();
    }

    @Test
    void any_other_account_marks_setup_completed() {
        assertThat(setupCompletedAfterMigration(
                        "setup_migration_user_it",
                        jdbc -> jdbc.update(
                                "INSERT INTO users (id, github_id, github_login, display_name, role, public_slug) "
                                        + "VALUES (?, 77, 'reader', 'Reader', 'USER', 'reader')",
                                UUID.randomUUID())))
                .isTrue();
    }

    private static boolean setupCompletedAfterMigration(String database, Consumer<JdbcTemplate> existingData) {
        DataSource dataSource = AbstractIntegrationTest.freshDataSource(database);
        flyway(dataSource, "35").migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        existingData.accept(jdbc);

        flyway(dataSource, "latest").migrate();

        Map<String, Object> row = jdbc.queryForMap("SELECT setup_completed, setup_completed_at FROM app_settings");
        boolean completed = (Boolean) row.get("setup_completed");
        assertThat(row.get("setup_completed_at") != null)
                .as("setup_completed_at")
                .isEqualTo(completed);
        assertThat(jdbc.queryForObject("SELECT count(*) FROM app_settings", Long.class))
                .isEqualTo(1L);
        return completed;
    }

    private static Flyway flyway(DataSource dataSource, String target) {
        return Flyway.configure()
                .dataSource(dataSource)
                .placeholders(Map.of("defaultLocale", "vi"))
                .target(target)
                .load();
    }
}
