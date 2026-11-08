package com.blog.newsletter;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.support.AbstractIntegrationTest;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * V48 (the newsletter of an author's post is held) on a database that already holds newsletter issues, the way an upgrading site
 * does: Flyway builds a separate DB up to V47, the test writes issues, and only then runs V48. No Spring context: only the SQL of
 * the migration is checked.
 *
 * An issue that is still PENDING when the site is upgraded has not been split into mails yet. If it belongs to a post that an
 * AUTHOR wrote it must wait for an administrator like every issue created afterwards, or the window of the upgrade (an author's post
 * queued, or taken down and published again, around it) would still mail every subscriber unseen. An issue that was already
 * expanded has been mailed and stays as it is.
 */
class HeldNewsletterMigrationIT {

    @Test
    void v48_holds_the_pending_issues_of_posts_that_an_author_wrote_and_leaves_the_others_alone() {
        DataSource dataSource = AbstractIntegrationTest.freshDataSource("held_newsletter_migration_it");
        flyway(dataSource).target("47").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);

        UUID author = account(jdbc, "AUTHOR");
        UUID admin = account(jdbc, "ADMIN");
        UUID authorsPending = post(jdbc, author, "authors-pending");
        UUID adminsPending = post(jdbc, admin, "admins-pending");
        UUID authorsMailed = post(jdbc, author, "authors-mailed");
        UUID adminsMailed = post(jdbc, admin, "admins-mailed");
        jdbc.update("INSERT INTO newsletter_issues (post_id, status) VALUES (?, 'PENDING')", authorsPending);
        jdbc.update("INSERT INTO newsletter_issues (post_id, status) VALUES (?, 'PENDING')", adminsPending);
        jdbc.update(
                "INSERT INTO newsletter_issues (post_id, status, expanded_at) VALUES (?, 'EXPANDED', now())",
                authorsMailed);
        jdbc.update(
                "INSERT INTO newsletter_issues (post_id, status, expanded_at) VALUES (?, 'EXPANDED', now())",
                adminsMailed);

        flyway(dataSource).target("48").load().migrate();

        assertThat(status(jdbc, authorsPending))
                .as("not mailed yet and written by an author")
                .isEqualTo("HELD");
        assertThat(status(jdbc, adminsPending))
                .as("written by an administrator")
                .isEqualTo("PENDING");
        assertThat(status(jdbc, authorsMailed)).as("already mailed").isEqualTo("EXPANDED");
        assertThat(status(jdbc, adminsMailed)).isEqualTo("EXPANDED");
        // A held issue has no decision yet, which the check constraint of the same migration requires.
        assertThat(jdbc.queryForObject(
                        "SELECT count(*) FROM newsletter_issues WHERE status = 'HELD' AND decided_at IS NULL",
                        Long.class))
                .isEqualTo(1);
    }

    /** V34 reads the placeholder defaultLocale, which the application configuration supplies. */
    private static FluentConfiguration flyway(DataSource dataSource) {
        return Flyway.configure().dataSource(dataSource).placeholders(Map.of("defaultLocale", "vi"));
    }

    private static UUID account(JdbcTemplate jdbc, String role) {
        UUID id = UUID.randomUUID();
        jdbc.update(
                "INSERT INTO users (id, email, password_hash, display_name, role, public_slug) VALUES (?, ?, 'x', ?, ?, ?)",
                id,
                "u-" + id + "@blog.local",
                role + " " + id,
                role,
                "slug-" + id);
        return id;
    }

    private static UUID post(JdbcTemplate jdbc, UUID author, String slug) {
        UUID id = UUID.randomUUID();
        jdbc.update(
                "INSERT INTO posts (id, title, slug, content, status, language, author_id, published_at) "
                        + "VALUES (?, ?, ?, 'Body', 'PUBLISHED', 'en', ?, now())",
                id,
                "Held migration " + slug,
                slug + "-" + id,
                author);
        return id;
    }

    private static String status(JdbcTemplate jdbc, UUID postId) {
        return jdbc.queryForObject("SELECT status FROM newsletter_issues WHERE post_id = ?", String.class, postId);
    }
}
