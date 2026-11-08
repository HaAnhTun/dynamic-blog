package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.common.security.SeedAdmin;
import com.blog.common.text.ReadingTime;
import com.blog.post.dto.PostLimits;
import com.blog.post.service.PostReadingMinutesBackfill;
import com.blog.support.AbstractIntegrationTest;
import java.util.Map;
import java.util.UUID;
import javax.sql.DataSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * V47 and the startup backfill on a database that already holds posts (issue 013): an old row has no figure (0) after the
 * migration, and the backfill gives it the same figure that the application computes from the body, without touching
 * anything else of the row.
 */
class PostReadingMinutesBackfillIT extends AbstractIntegrationTest {

    @Autowired
    private PostReadingMinutesBackfill backfill;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void the_migration_gives_old_rows_a_zero_and_the_backfill_fills_it_exactly_without_touching_the_row() {
        DataSource dataSource = AbstractIntegrationTest.freshDataSource("post_reading_minutes_it");
        Flyway.configure()
                .dataSource(dataSource)
                .placeholders(Map.of("defaultLocale", "vi"))
                .target("46")
                .load()
                .migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        UUID id = UUID.randomUUID();
        String body = ":::callout{type=\"info\"}\n" + "word ".repeat(450) + "\n:::\n";
        jdbc.update(
                "INSERT INTO posts (id, title, slug, content, status, author_id) VALUES (?, 'Old', 'old-post', ?, 'DRAFT', ?)",
                id,
                body,
                SeedAdmin.ID);
        Object updatedBefore = jdbc.queryForObject("SELECT updated_at FROM posts WHERE id = ?", Object.class, id);

        Flyway.configure()
                .dataSource(dataSource)
                .placeholders(Map.of("defaultLocale", "vi"))
                .target("47")
                .load()
                .migrate();

        assertThat(jdbc.queryForObject("SELECT reading_minutes FROM posts WHERE id = ?", Integer.class, id))
                .isZero();
        int filled = new PostReadingMinutesBackfill(jdbc).run();
        assertThat(filled).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT reading_minutes FROM posts WHERE id = ?", Integer.class, id))
                .isEqualTo(ReadingTime.minutes(body))
                .isEqualTo(3);
        assertThat(jdbc.queryForObject("SELECT updated_at FROM posts WHERE id = ?", Object.class, id))
                .isEqualTo(updatedBefore);
        // A second run has nothing left to do.
        assertThat(new PostReadingMinutesBackfill(jdbc).run()).isZero();
    }

    /**
     * A site that already holds a post over the limits of V46 (an excerpt of up to 4,000 characters came in through the file
     * import, and a body had no cap at all): the CHECKs stay NOT VALID, and PostgreSQL still enforces a NOT VALID CHECK on every
     * UPDATE of the row. An UPDATE of such a row, even of this one column, fails, so the backfill must leave it alone instead of
     * stopping the start of the backend.
     */
    @Test
    void the_backfill_skips_a_post_over_the_limits_and_still_fills_the_others() {
        DataSource dataSource = AbstractIntegrationTest.freshDataSource("post_reading_minutes_long_it");
        Flyway.configure()
                .dataSource(dataSource)
                .placeholders(Map.of("defaultLocale", "vi"))
                .target("45")
                .load()
                .migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        UUID longBody = insertOldPost(jdbc, "long-body", "word ".repeat(PostLimits.CONTENT_MAX / 5) + "x", null);
        UUID longExcerpt =
                insertOldPost(jdbc, "long-excerpt", "word ".repeat(300), "e".repeat(PostLimits.EXCERPT_MAX + 1));
        UUID normal = insertOldPost(jdbc, "normal", "word ".repeat(450), "short");
        UUID atTheLimit = insertOldPost(
                jdbc, "at-the-limit", "w".repeat(PostLimits.CONTENT_MAX), "e".repeat(PostLimits.EXCERPT_MAX));

        Flyway.configure()
                .dataSource(dataSource)
                .placeholders(Map.of("defaultLocale", "vi"))
                .target("47")
                .load()
                .migrate();
        assertThat(jdbc.queryForObject(
                        "SELECT count(*) FROM pg_constraint WHERE conname IN ('chk_posts_content_size', 'chk_posts_excerpt_size') AND NOT convalidated",
                        Integer.class))
                .as("V46 leaves both constraints NOT VALID when a post is over a limit")
                .isEqualTo(2);

        int filled = new PostReadingMinutesBackfill(jdbc).run();

        assertThat(filled).isEqualTo(2);
        assertThat(minutes(jdbc, normal)).isEqualTo(3);
        assertThat(minutes(jdbc, atTheLimit)).isPositive();
        assertThat(minutes(jdbc, longBody)).isZero();
        assertThat(minutes(jdbc, longExcerpt)).isZero();
        // The rows that were skipped stay skipped: a second run neither fails nor loops over them, and they are
        // counted.
        assertThat(new PostReadingMinutesBackfill(jdbc).run()).isZero();
        assertThat(new PostReadingMinutesBackfill(jdbc).countSkipped()).isEqualTo(2);
    }

    private static UUID insertOldPost(JdbcTemplate jdbc, String slug, String body, String excerpt) {
        UUID id = UUID.randomUUID();
        jdbc.update(
                "INSERT INTO posts (id, title, slug, content, excerpt, status, author_id) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?)",
                id,
                slug,
                slug,
                body,
                excerpt,
                SeedAdmin.ID);
        return id;
    }

    private static int minutes(JdbcTemplate jdbc, UUID id) {
        return jdbc.queryForObject("SELECT reading_minutes FROM posts WHERE id = ?", Integer.class, id);
    }

    @Test
    void the_backfill_bean_of_the_application_does_the_same_on_the_shared_database() {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO posts (id, title, slug, content, status, language, author_id, reading_minutes) "
                        + "VALUES (?, 'Zero', ?, ?, 'DRAFT', 'en', ?, 0)",
                id,
                "backfill-" + id,
                "word ".repeat(700),
                SeedAdmin.ID);

        assertThat(backfill.run()).isGreaterThanOrEqualTo(1);

        assertThat(jdbcTemplate.queryForObject("SELECT reading_minutes FROM posts WHERE id = ?", Integer.class, id))
                .isEqualTo(4);
    }
}
