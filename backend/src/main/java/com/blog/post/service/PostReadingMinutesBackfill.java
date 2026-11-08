package com.blog.post.service;

import com.blog.common.text.ReadingTime;
import com.blog.post.dto.PostLimits;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * Fills {@code posts.reading_minutes} for the rows that still have 0 (every post that existed before migration V47), with the
 * same function that sets it on every write ({@link ReadingTime}). Runs once the singletons exist, which is after Flyway and
 * before the web server accepts a request, so a list never shows the placeholder. Plain JDBC on purpose: it must not run the
 * entity callbacks (which would move {@code updated_at}) or change anything but this column.
 *
 * A post that is over the text limits of migration V46 is skipped: that migration leaves its CHECK constraints NOT VALID on a
 * database that holds such a post, and PostgreSQL still enforces a NOT VALID constraint on every UPDATE of the row, so writing
 * even this one column would fail and stop the backend from starting. The row keeps 0 (a card shows 1 minute) until its text is
 * shortened; {@code Post.setContent} stores the figure then. The selection uses the same {@code char_length} as the constraints.
 *
 * Does nothing on a database that has no such row, which is every start after the first.
 */
@Component
public class PostReadingMinutesBackfill implements SmartInitializingSingleton {

    private static final Logger log = LoggerFactory.getLogger(PostReadingMinutesBackfill.class);

    private static final int BATCH = 50;

    /** The two CHECK constraints of V46, as a condition: a row that satisfies it can be updated even while they are NOT VALID. */
    private static final String WITHIN_LIMITS =
            "char_length(content) <= ? AND (excerpt IS NULL OR char_length(excerpt) <= ?)";

    private final JdbcTemplate jdbc;

    public PostReadingMinutesBackfill(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @Override
    public void afterSingletonsInstantiated() {
        int filled = run();
        if (filled > 0) {
            log.info("reading time stored for {} post(s) that had none", filled);
        }
        int skipped = countSkipped();
        if (skipped > 0) {
            // Neither slug nor text: the owner finds them with the query of docs/UPGRADING.md.
            log.warn(
                    "reading time not stored for {} post(s) longer than the text limits (body {}, excerpt {} characters);"
                            + " shorten them, see docs/UPGRADING.md",
                    skipped,
                    PostLimits.CONTENT_MAX,
                    PostLimits.EXCERPT_MAX);
        }
    }

    /** @return the number of posts that got a reading time */
    public int run() {
        int total = 0;
        while (true) {
            List<Object[]> batch = jdbc.query(
                    "SELECT id, content FROM posts WHERE reading_minutes = 0 AND " + WITHIN_LIMITS
                            + " ORDER BY id LIMIT ?",
                    (rs, row) ->
                            new Object[] {ReadingTime.minutes(rs.getString("content")), rs.getObject("id", UUID.class)},
                    PostLimits.CONTENT_MAX,
                    PostLimits.EXCERPT_MAX,
                    BATCH);
            if (batch.isEmpty()) {
                return total;
            }
            jdbc.batchUpdate("UPDATE posts SET reading_minutes = ? WHERE id = ? AND reading_minutes = 0", batch);
            total += batch.size();
        }
    }

    /** @return the number of posts that still have no reading time because their text is over the limits */
    public int countSkipped() {
        Integer count = jdbc.queryForObject(
                "SELECT count(*) FROM posts WHERE reading_minutes = 0 AND NOT (" + WITHIN_LIMITS + ")",
                Integer.class,
                PostLimits.CONTENT_MAX,
                PostLimits.EXCERPT_MAX);
        return count == null ? 0 : count;
    }
}
