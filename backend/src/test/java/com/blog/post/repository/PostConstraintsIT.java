package com.blog.post.repository;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.support.AbstractIntegrationTest;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.postgresql.util.PSQLException;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The database backstops of V50, with plain SQL (what a script or a hand-written statement would send): a status that does not
 * exist, a published post without a date, a slug that is not a slug, a slug that is both a current slug and the old slug of
 * another post, an image bigger than the limit, a reply to a reply. Each is a rule the services already follow; here the
 * database refuses the row even when no service is in the way.
 *
 * The DB is shared and never cleaned: every slug has a random suffix.
 */
class PostConstraintsIT extends AbstractIntegrationTest {

    @Autowired
    private JdbcTemplate jdbcTemplate;

    private UUID adminId() {
        return jdbcTemplate.queryForObject("SELECT id FROM users WHERE email = 'admin@blog.local'", UUID.class);
    }

    private static String token() {
        return UUID.randomUUID().toString().substring(0, 8);
    }

    private UUID insertPost(String slug, String status, boolean published) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO posts (id, title, slug, content, status, author_id, published_at) "
                        + "VALUES (?, 'Constraint test', ?, 'Content', ?, ?, " + (published ? "now()" : "NULL") + ")",
                id,
                slug,
                status,
                adminId());
        return id;
    }

    /** The statement is refused by exactly this constraint (the name PostgreSQL reports, for a CHECK or a trigger alike). */
    private void assertRefused(Runnable statement, String constraint) {
        assertThatThrownBy(statement::run)
                .isInstanceOf(DataIntegrityViolationException.class)
                .rootCause()
                .isInstanceOfSatisfying(
                        PSQLException.class,
                        e -> assertThat(e.getServerErrorMessage().getConstraint())
                                .isEqualTo(constraint));
    }

    @Test
    void a_post_has_one_of_the_three_statuses() {
        String slug = "status-" + token();
        assertRefused(() -> insertPost(slug, "PUBLIC", false), "chk_posts_status");
        insertPost(slug, "DRAFT", false);
        insertPost("archived-" + token(), "ARCHIVED", false);
    }

    @Test
    void a_published_post_has_a_publish_date() {
        assertRefused(() -> insertPost("undated-" + token(), "PUBLISHED", false), "chk_posts_published_at");
        insertPost("dated-" + token(), "PUBLISHED", true);
    }

    @Test
    void a_slug_is_lower_case_words_joined_by_single_hyphens() {
        for (String bad : new String[] {
            "Upper-" + token(),
            "has space " + token(),
            "trailing-" + token() + "-",
            "double--hyphen",
            "-leading",
            "under_score",
            ""
        }) {
            assertRefused(() -> insertPost(bad, "DRAFT", false), "chk_posts_slug_format");
        }
        insertPost("a-good-slug-2-" + token(), "DRAFT", false);
    }

    @Test
    void an_old_slug_cannot_be_the_current_slug_of_another_post_and_the_reverse() {
        String taken = "taken-" + token();
        UUID holder = insertPost(taken, "DRAFT", false);
        UUID other = insertPost("other-" + token(), "DRAFT", false);

        assertRefused(
                () -> jdbcTemplate.update(
                        "INSERT INTO post_slug_history (old_slug, post_id) VALUES (?, ?)", taken, other),
                "chk_post_slug_history_not_current");
        // The post's own current slug is not "another post's".
        jdbcTemplate.update("INSERT INTO post_slug_history (old_slug, post_id) VALUES (?, ?)", taken, holder);
        jdbcTemplate.update("DELETE FROM post_slug_history WHERE old_slug = ?", taken);

        String retired = "retired-" + token();
        jdbcTemplate.update("INSERT INTO post_slug_history (old_slug, post_id) VALUES (?, ?)", retired, holder);
        assertRefused(
                () -> jdbcTemplate.update("UPDATE posts SET slug = ? WHERE id = ?", retired, other),
                "chk_posts_slug_not_old_slug");
        assertRefused(() -> insertPost(retired, "DRAFT", false), "chk_posts_slug_not_old_slug");
        // The post that retired the slug may take it back (after the history row is gone, as PostService does).
        jdbcTemplate.update("DELETE FROM post_slug_history WHERE old_slug = ?", retired);
        jdbcTemplate.update("UPDATE posts SET slug = ? WHERE id = ?", retired, holder);
    }

    @Test
    void an_image_in_the_database_is_at_most_four_mebibytes() {
        UUID media = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO media (id, content_type, width, height, byte_size, sha256) VALUES (?, 'image/png', 1, 1, 100, ?)",
                media,
                "ab".repeat(32));
        assertRefused(
                () -> jdbcTemplate.update(
                        "INSERT INTO media_content (media_id, data) VALUES (?, ?)",
                        media,
                        new byte[4 * 1024 * 1024 + 1]),
                "chk_media_content_size");
        jdbcTemplate.update(
                "INSERT INTO media_content (media_id, data) VALUES (?, ?)", media, new byte[4 * 1024 * 1024]);
    }

    @Test
    void a_reply_cannot_have_replies() {
        UUID post = insertPost("thread-" + token(), "PUBLISHED", true);
        UUID root = UUID.randomUUID();
        UUID reply = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO comments (id, post_id, user_id, content) VALUES (?, ?, ?, 'A root comment')",
                root,
                post,
                adminId());
        jdbcTemplate.update(
                "INSERT INTO comments (id, post_id, user_id, parent_id, content) VALUES (?, ?, ?, ?, 'A reply')",
                reply,
                post,
                adminId(),
                root);

        assertRefused(
                () -> jdbcTemplate.update(
                        "INSERT INTO comments (id, post_id, user_id, parent_id, content) VALUES (?, ?, ?, ?, 'A reply to a reply')",
                        UUID.randomUUID(),
                        post,
                        adminId(),
                        reply),
                "chk_comments_reply_depth");
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM comments WHERE post_id = ?", Long.class, post))
                .isEqualTo(2);
    }

    @Test
    void a_hidden_post_is_never_published() {
        UUID post = insertPost("hidden-" + token(), "PUBLISHED", true);

        assertRefused(
                () -> jdbcTemplate.update("UPDATE posts SET deleted_at = now() WHERE id = ?", post),
                "chk_posts_deleted_not_published");
        jdbcTemplate.update("UPDATE posts SET status = 'ARCHIVED', deleted_at = now() WHERE id = ?", post);
    }
}
