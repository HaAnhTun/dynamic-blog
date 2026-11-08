package com.blog.post;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.common.security.SeedAdmin;
import com.blog.post.dto.PostLimits;
import com.blog.support.AbstractIntegrationTest;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;

/**
 * The application starts on a database that holds a post over the limits of V46 (issue 013). The database is built to
 * version 45 and filled with the old data before the context exists; the context then runs V46 and V47 itself and the
 * reading-time backfill at startup. PostgreSQL enforces a NOT VALID CHECK on every UPDATE of the row, so a backfill that
 * wrote the over-long row would fail and the backend would refuse to start: this class not starting is the regression.
 */
@SpringBootTest
@TestPropertySource(
        properties = {
            "app.oauth.github.client-id=",
            "app.oauth.github.client-secret=",
            "app.oauth.github.redirect-uri=",
            "app.oauth.github.site-url=",
            "app.admin.github-id=",
            "app.security.refresh-token-cleanup-cron=-",
            "app.newsletter.worker-enabled=false",
            "app.search.worker-enabled=false",
            "app.search.reconcile-cron=-"
        })
class PostReadingMinutesBackfillStartupIT {

    private static final UUID LONG_POST = UUID.randomUUID();
    private static final UUID NORMAL_POST = UUID.randomUUID();

    @DynamicPropertySource
    static void databaseWithAnOverLongPost(DynamicPropertyRegistry registry) {
        DriverManagerDataSource dataSource = AbstractIntegrationTest.freshDataSource("post_backfill_startup_it");
        Flyway.configure()
                .dataSource(dataSource)
                .placeholders(Map.of("defaultLocale", "vi"))
                .target("45")
                .load()
                .migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        insert(jdbc, LONG_POST, "long-excerpt", "word ".repeat(100), "e".repeat(PostLimits.EXCERPT_MAX + 1));
        insert(jdbc, NORMAL_POST, "normal", "word ".repeat(450), "short");
        registry.add("spring.datasource.url", dataSource::getUrl);
        registry.add("spring.datasource.username", dataSource::getUsername);
        registry.add("spring.datasource.password", dataSource::getPassword);
    }

    private static void insert(JdbcTemplate jdbc, UUID id, String slug, String body, String excerpt) {
        jdbc.update(
                "INSERT INTO posts (id, title, slug, content, excerpt, status, author_id) VALUES (?, ?, ?, ?, ?, 'DRAFT', ?)",
                id,
                slug,
                slug,
                body,
                excerpt,
                SeedAdmin.ID);
    }

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void the_application_starts_fills_the_normal_post_and_leaves_the_over_long_one_at_zero() {
        assertThat(minutes(NORMAL_POST)).isEqualTo(3);
        assertThat(minutes(LONG_POST)).isZero();
    }

    private int minutes(UUID id) {
        return jdbcTemplate.queryForObject("SELECT reading_minutes FROM posts WHERE id = ?", Integer.class, id);
    }
}
