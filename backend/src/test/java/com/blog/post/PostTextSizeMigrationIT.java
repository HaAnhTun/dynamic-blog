package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.security.SeedAdmin;
import com.blog.support.AbstractIntegrationTest;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * V46 on databases that already hold posts (issue 013): Flyway builds a separate DB up to V45, the test writes posts like the
 * running site has, then migrates. A clean site gets validated constraints; a site with a post above the limit still starts,
 * keeps the constraints NOT VALID, can shorten that post, and refuses new oversized text.
 */
class PostTextSizeMigrationIT {

    private static final int CONTENT_MAX = 500_000;
    private static final int EXCERPT_MAX = 1_000;

    private static Flyway flyway(DataSource dataSource, String target) {
        return Flyway.configure()
                .dataSource(dataSource)
                .placeholders(Map.of("defaultLocale", "vi"))
                .target(target)
                .load();
    }

    private static UUID post(JdbcTemplate jdbc, String slug, String excerpt, int contentLength) {
        UUID id = UUID.randomUUID();
        jdbc.update(
                "INSERT INTO posts (id, title, slug, excerpt, content, status, author_id) "
                        + "VALUES (?, ?, ?, ?, repeat('x', ?), 'DRAFT', ?)",
                id,
                "Title " + slug,
                slug,
                excerpt,
                contentLength,
                SeedAdmin.ID);
        return id;
    }

    private static Boolean validated(JdbcTemplate jdbc, String constraint) {
        return jdbc.queryForObject(
                "SELECT convalidated FROM pg_constraint WHERE conname = ?", Boolean.class, constraint);
    }

    @Test
    void a_clean_site_gets_validated_constraints_that_refuse_oversized_text() {
        DataSource dataSource = AbstractIntegrationTest.freshDataSource("post_text_size_clean_it");
        flyway(dataSource, "45").migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        post(jdbc, "at-the-limit", "e".repeat(EXCERPT_MAX), CONTENT_MAX);

        flyway(dataSource, "46").migrate();

        assertThat(validated(jdbc, "chk_posts_content_size")).isTrue();
        assertThat(validated(jdbc, "chk_posts_excerpt_size")).isTrue();
        assertThatThrownBy(() -> post(jdbc, "too-long", null, CONTENT_MAX + 1))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> post(jdbc, "long-excerpt", "e".repeat(EXCERPT_MAX + 1), 10))
                .isInstanceOf(DataIntegrityViolationException.class);
        // The text of a revision is not limited: it is a copy of what a post held before an edit.
        UUID id = post(jdbc, "has-a-revision", null, 10);
        jdbc.update(
                "INSERT INTO post_revisions (post_id, title, excerpt, content) VALUES (?, 'Old', NULL, repeat('y', ?))",
                id,
                CONTENT_MAX + 1);
    }

    @Test
    void a_site_with_a_post_above_the_limit_still_migrates_and_can_shorten_it() {
        DataSource dataSource = AbstractIntegrationTest.freshDataSource("post_text_size_legacy_it");
        flyway(dataSource, "45").migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        UUID legacy = post(jdbc, "legacy-long", "e".repeat(EXCERPT_MAX + 5), CONTENT_MAX + 10);
        UUID normal = post(jdbc, "normal", null, 100);

        // The migration does not fail on the old row ...
        flyway(dataSource, "46").migrate();

        // ... it leaves the constraints NOT VALID, and still refuses new oversized text ...
        assertThat(validated(jdbc, "chk_posts_content_size")).isFalse();
        assertThat(validated(jdbc, "chk_posts_excerpt_size")).isFalse();
        assertThatThrownBy(() -> post(jdbc, "new-too-long", null, CONTENT_MAX + 1))
                .isInstanceOf(DataIntegrityViolationException.class);
        // ... an unrelated row is not affected, the old row can be read, and shortening it works.
        assertThat(jdbc.update("UPDATE posts SET title = 'Renamed' WHERE id = ?", normal))
                .isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT char_length(content) FROM posts WHERE id = ?", Integer.class, legacy))
                .isEqualTo(CONTENT_MAX + 10);
        assertThatThrownBy(() -> jdbc.update("UPDATE posts SET title = 'Renamed' WHERE id = ?", legacy))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(jdbc.update("UPDATE posts SET content = repeat('x', 10), excerpt = NULL WHERE id = ?", legacy))
                .isEqualTo(1);

        // Once nothing is above the limit, VALIDATE CONSTRAINT works.
        jdbc.execute("ALTER TABLE posts VALIDATE CONSTRAINT chk_posts_content_size");
        jdbc.execute("ALTER TABLE posts VALIDATE CONSTRAINT chk_posts_excerpt_size");
        assertThat(validated(jdbc, "chk_posts_content_size")).isTrue();
    }
}
