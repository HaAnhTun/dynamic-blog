package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.security.SeedAdmin;
import com.blog.support.AbstractIntegrationTest;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * V34 and V35 on a database that already holds content: Flyway builds a separate DB up to V33, the test writes rows like the
 * running site has (drafts, published, soft states, slug history, subscribers, taxonomy), then migrates and checks that every
 * old row took the default locale, that nothing else changed, and that the constraints reject what they must.
 */
class ContentLanguageMigrationIT {

    private static Flyway flyway(DataSource dataSource, String defaultLocale, String target) {
        return Flyway.configure()
                .dataSource(dataSource)
                .placeholders(Map.of("defaultLocale", defaultLocale))
                .target(target)
                .load();
    }

    private static UUID category(JdbcTemplate jdbc, String name) {
        UUID id = UUID.randomUUID();
        jdbc.update("INSERT INTO categories (id, name, slug) VALUES (?, ?, ?)", id, name, name.toLowerCase());
        return id;
    }

    private static UUID post(JdbcTemplate jdbc, UUID category, String slug, String status) {
        UUID id = UUID.randomUUID();
        jdbc.update(
                "INSERT INTO posts (id, title, slug, content, status, author_id, category_id, published_at) "
                        + "VALUES (?, ?, ?, 'body', ?, ?, ?, CASE WHEN ? = 'DRAFT' THEN NULL ELSE now() END)",
                id,
                "Title " + slug,
                slug,
                status,
                SeedAdmin.ID,
                category,
                status);
        return id;
    }

    @Test
    void v34_and_v35_backfill_the_default_locale_keep_old_rows_and_build_every_constraint() {
        DataSource dataSource = AbstractIntegrationTest.freshDataSource("content_language_migration_it");
        flyway(dataSource, "vi", "33").migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);

        UUID category = category(jdbc, "Backend");
        UUID published = post(jdbc, category, "published-post", "PUBLISHED");
        UUID draft = post(jdbc, category, "draft-post", "DRAFT");
        UUID moved = post(jdbc, category, "moved-post", "PUBLISHED");
        jdbc.update("INSERT INTO post_slug_history (old_slug, post_id) VALUES ('old-name', ?)", moved);
        jdbc.update("INSERT INTO tags (name, slug) VALUES ('Java', 'java')");
        jdbc.update("INSERT INTO series (title, slug) VALUES ('Series one', 'series-one')");
        jdbc.update("INSERT INTO newsletter_subscribers (email, status, confirmed_at) "
                + "VALUES ('reader@example.invalid', 'CONFIRMED', now())");
        long postsBefore = jdbc.queryForObject("SELECT count(*) FROM posts", Long.class);

        flyway(dataSource, "vi", "35").migrate();

        assertThat(jdbc.queryForObject("SELECT count(*) FROM posts", Long.class))
                .isEqualTo(postsBefore);
        assertThat(jdbc.queryForList("SELECT DISTINCT language FROM posts", String.class))
                .containsExactly("vi");
        assertThat(jdbc.queryForObject("SELECT count(*) FROM posts WHERE translation_group_id IS NOT NULL", Long.class))
                .isZero();
        assertThat(jdbc.queryForObject("SELECT status FROM posts WHERE id = ?", String.class, draft))
                .isEqualTo("DRAFT");
        assertThat(jdbc.queryForObject("SELECT slug FROM posts WHERE id = ?", String.class, published))
                .isEqualTo("published-post");
        assertThat(jdbc.queryForObject("SELECT post_id FROM post_slug_history WHERE old_slug = 'old-name'", UUID.class))
                .isEqualTo(moved);
        assertThat(jdbc.queryForObject("SELECT locale FROM newsletter_subscribers", String.class))
                .isEqualTo("vi");
        for (String table : List.of("categories", "tags", "series")) {
            assertThat(jdbc.queryForObject("SELECT DISTINCT translations::text FROM " + table, String.class))
                    .as(table)
                    .isEqualTo("{}");
        }

        // A second translation of the same article: one post per language in a group.
        UUID group = UUID.randomUUID();
        jdbc.update("UPDATE posts SET translation_group_id = ? WHERE id = ?", group, published);
        UUID english = post(jdbc, category, "published-post-en", "PUBLISHED");
        jdbc.update("UPDATE posts SET translation_group_id = ?, language = 'en' WHERE id = ?", group, english);
        UUID second = post(jdbc, category, "second-vi", "DRAFT");
        assertThatThrownBy(() -> jdbc.update("UPDATE posts SET translation_group_id = ? WHERE id = ?", group, second))
                .isInstanceOf(DataIntegrityViolationException.class);
        // Unlinked posts of one language never collide, whatever their number.
        post(jdbc, category, "another-unlinked", "DRAFT");

        assertThatThrownBy(() -> jdbc.update("UPDATE posts SET language = 'fr' WHERE id = ?", draft))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE posts SET language = NULL WHERE id = ?", draft))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE categories SET translations = '[]'::jsonb"))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> jdbc.update("UPDATE tags SET translations = '{\"fr\": {\"name\": \"x\"}}'::jsonb"))
                .isInstanceOf(DataIntegrityViolationException.class);
        jdbc.update("UPDATE tags SET translations = '{\"en\": {\"name\": \"Java\"}}'::jsonb");
        assertThatThrownBy(() -> jdbc.update("UPDATE newsletter_subscribers SET locale = 'de'"))
                .isInstanceOf(DataIntegrityViolationException.class);

        // The index a language filter relies on exists.
        assertThat(jdbc.queryForObject(
                        "SELECT count(*) FROM pg_indexes WHERE indexname = 'idx_posts_language_status_published_at'",
                        Long.class))
                .isEqualTo(1);
    }

    @Test
    void the_default_locale_placeholder_decides_the_language_of_existing_rows() {
        DataSource dataSource = AbstractIntegrationTest.freshDataSource("content_language_placeholder_it");
        flyway(dataSource, "en", "33").migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        post(jdbc, category(jdbc, "General"), "english-site-post", "PUBLISHED");
        jdbc.update("INSERT INTO newsletter_subscribers (email, status, confirmed_at) "
                + "VALUES ('someone@example.invalid', 'CONFIRMED', now())");

        flyway(dataSource, "en", "35").migrate();

        assertThat(jdbc.queryForObject("SELECT language FROM posts", String.class))
                .isEqualTo("en");
        assertThat(jdbc.queryForObject("SELECT locale FROM newsletter_subscribers", String.class))
                .isEqualTo("en");
    }

    @Test
    void both_migrations_apply_on_an_empty_database() {
        DataSource dataSource = AbstractIntegrationTest.freshDataSource("content_language_clean_it");
        flyway(dataSource, "vi", "35").migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);

        // The seeded admin account is the only row; no post, so nothing was backfilled and the defaults are in place.
        assertThat(jdbc.queryForObject("SELECT count(*) FROM posts", Long.class))
                .isZero();
        UUID id = post(jdbc, category(jdbc, "Clean"), "clean-post", "DRAFT");
        assertThat(jdbc.queryForObject("SELECT language FROM posts WHERE id = ?", String.class, id))
                .isEqualTo("vi");
    }
}
