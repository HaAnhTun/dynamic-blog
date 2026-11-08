package com.blog.user;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.blog.comment.entity.Comment;
import com.blog.comment.entity.CommentStatus;
import com.blog.like.entity.PostLike;
import com.blog.like.entity.PostLikeId;
import com.blog.post.entity.Post;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.user.entity.User;
import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Schema V5 (V18 users, V19 comments, V20 post_likes): what the DB keeps by itself, even when the code forgets.
 *
 * Checked with plain SQL, not through a service: each constraint is the last net behind the service, and must stand on its own.
 * Each violation checks the exact constraint NAME in Postgres's message, so the test does not pass because of another error (wrong column,
 * missing NOT NULL). The application starting at all is already proof that {@code ddl-auto: validate} matches the new entities.
 *
 * The shared DB is never cleaned: emails and slugs have random suffixes, GitHub ids come from
 * {@link AuthTestSupport#nextGithubId()}; posts created here are DRAFT so no public page sees them.
 */
@AutoConfigureMockMvc
class UserSchemaIT extends AbstractIntegrationTest {

    private static final UUID SEEDED_ADMIN = UUID.fromString("00000000-0000-0000-0000-000000000001");

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @PersistenceContext
    private EntityManager entityManager;

    private String suffix;

    @BeforeEach
    void setUp() {
        suffix = UUID.randomUUID().toString().substring(0, 8);
    }

    // --- users (V18) -----------------------------------------------------------------------------------

    @Test
    void seed_admin_is_intact_after_v18_still_ADMIN_ACTIVE_with_email_and_argon2_hash() {
        Map<String, Object> admin = jdbcTemplate.queryForMap(
                "SELECT email, password_hash, display_name, role, status FROM users WHERE id = ?", SEEDED_ADMIN);

        assertThat(admin.get("email")).isEqualTo("admin@blog.local");
        assertThat(admin.get("role")).isEqualTo("ADMIN");
        // The new column is NOT NULL DEFAULT 'ACTIVE': an existing row gets the default right inside the migration.
        assertThat(admin.get("status")).isEqualTo("ACTIVE");
        assertThat(admin.get("display_name")).isEqualTo("Admin");
        assertThat((String) admin.get("password_hash")).startsWith("$argon2id$");
    }

    @Test
    void github_id_is_unique_while_null_email_allows_any_number_of_readers() {
        long githubId = auth.nextGithubId();
        // Two readers, neither with an email: UNIQUE on email (V1) treats each NULL as different.
        insertUser(null, null, "USER", "ACTIVE", githubId);
        insertUser(null, null, "USER", "ACTIVE", auth.nextGithubId());

        assertThatThrownBy(() -> insertUser(null, null, "USER", "ACTIVE", githubId))
                .isInstanceOf(DuplicateKeyException.class)
                .hasMessageContaining("uq_users_github_id");
    }

    @Test
    void users_check_blocks_unknown_status_and_role() {
        assertThatThrownBy(() -> insertUser(null, null, "USER", "BANNED", auth.nextGithubId()))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("chk_users_status");
        assertThatThrownBy(() -> insertUser(null, null, "GUEST", "ACTIVE", auth.nextGithubId()))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("chk_users_role");

        // Control: valid values are accepted. For ADMIN the seed admin is already the proof: ADD CONSTRAINT also checks
        // the rows that exist when the migration runs.
        insertUser("check-author-" + suffix + "@blog.local", "$argon2id$x", "AUTHOR", "ACTIVE", null);
        insertUser(null, null, "USER", "SUSPENDED", auth.nextGithubId());
    }

    @Test
    void every_account_must_be_able_to_log_in_with_GitHub_or_with_email_plus_password() {
        String email = "credential-" + suffix + "@blog.local";

        assertThatThrownBy(() -> insertUser(null, null, "USER", "ACTIVE", null))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("chk_users_has_credential");
        assertThatThrownBy(() -> insertUser(email, null, "AUTHOR", "ACTIVE", null))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("chk_users_has_credential");
        assertThatThrownBy(() -> insertUser(null, "$argon2id$x", "AUTHOR", "ACTIVE", null))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("chk_users_has_credential");

        // GitHub only, or an email with no password but with GitHub: both can log in.
        UUID reader = insertUser(null, null, "USER", "ACTIVE", auth.nextGithubId());
        insertUser(email, null, "USER", "ACTIVE", auth.nextGithubId());

        // The constraint holds on update too: removing GitHub from a GitHub-only reader would lock them out for good.
        assertThatThrownBy(() -> jdbcTemplate.update("UPDATE users SET github_id = NULL WHERE id = ?", reader))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("chk_users_has_credential");
    }

    // --- comments (V19) --------------------------------------------------------------------------------

    @Test
    void comment_length_is_counted_in_characters_from_2_to_2000_including_emoji_outside_the_BMP() {
        UUID post = insertDraftPost("do-dai");
        UUID reader = insertReader();

        insertComment(post, reader, null, "ok");
        insertComment(post, reader, null, "a".repeat(2000));
        // char_length counts code points, not UTF-16 units: 2000 emoji are 4000 chars in Java and still valid,
        // matching how CommentContent counts.
        insertComment(post, reader, null, Character.toString(0x1F600).repeat(2000));

        assertThatThrownBy(() -> insertComment(post, reader, null, "a"))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("chk_comments_content_length");
        assertThatThrownBy(() -> insertComment(post, reader, null, "a".repeat(2001)))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("chk_comments_content_length");
    }

    @Test
    void comment_status_is_only_VISIBLE_HIDDEN_DELETED_and_a_comment_is_not_its_own_parent() {
        UUID post = insertDraftPost("trang-thai");
        UUID reader = insertReader();

        for (String status : new String[] {"VISIBLE", "HIDDEN", "DELETED"}) {
            jdbcTemplate.update(
                    "INSERT INTO comments (post_id, user_id, content, status) VALUES (?, ?, ?, ?)",
                    post,
                    reader,
                    "status " + status,
                    status);
        }
        assertThatThrownBy(() -> jdbcTemplate.update(
                        "INSERT INTO comments (post_id, user_id, content, status) VALUES (?, ?, ?, 'SPAM')",
                        post,
                        reader,
                        "spam"))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("chk_comments_status");

        UUID self = UUID.randomUUID();
        assertThatThrownBy(() -> jdbcTemplate.update(
                        "INSERT INTO comments (id, post_id, user_id, parent_id, content) VALUES (?, ?, ?, ?, ?)",
                        self,
                        post,
                        reader,
                        self,
                        "replying to itself"))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("chk_comments_not_own_parent");
    }

    @Test
    void reply_must_belong_to_the_same_post_as_the_parent_comment() {
        UUID post = insertDraftPost("cung-bai");
        UUID other = insertDraftPost("bai-khac");
        UUID reader = insertReader();
        UUID root = insertComment(post, reader, null, "root comment");

        // Control: a reply on the same post is accepted.
        insertComment(post, reader, root, "reply on the same post");

        assertThatThrownBy(() -> insertComment(other, reader, root, "reply straying onto another post"))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("fk_comments_parent_same_post");
        assertThatThrownBy(
                        () -> insertComment(post, reader, UUID.randomUUID(), "reply to a comment that does not exist"))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("fk_comments_parent_same_post");
    }

    // --- post_likes (V20) ------------------------------------------------------------------------------

    @Test
    void one_person_likes_a_post_at_most_once() {
        UUID post = insertDraftPost("thich");
        UUID reader = insertReader();

        jdbcTemplate.update("INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)", post, reader);
        assertThatThrownBy(() ->
                        jdbcTemplate.update("INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)", post, reader))
                .isInstanceOf(DuplicateKeyException.class)
                .hasMessageContaining("post_likes_pkey");
        // The real like statement uses ON CONFLICT DO NOTHING: the second time changes 0 rows and throws no error.
        assertThat(jdbcTemplate.update(
                        "INSERT INTO post_likes (post_id, user_id) VALUES (?, ?) "
                                + "ON CONFLICT (post_id, user_id) DO NOTHING",
                        post,
                        reader))
                .isZero();
        assertThat(countLikes(post)).isEqualTo(1);
    }

    // --- Cascading delete ------------------------------------------------------------------------------

    @Test
    void deleting_post_through_admin_api_cascades_to_comments_replies_and_likes_of_that_post_only() throws Exception {
        UUID doomed = insertDraftPost("bi-xoa");
        UUID kept = insertDraftPost("con-lai");
        UUID reader = insertReader();
        UUID root = insertComment(doomed, reader, null, "root of the deleted post");
        insertComment(doomed, reader, root, "reply on the deleted post");
        jdbcTemplate.update("INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)", doomed, reader);
        UUID keptComment = insertComment(kept, reader, null, "comment on the remaining post");
        jdbcTemplate.update("INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)", kept, reader);

        // The real delete path of V4 (Hibernate deletes post_tags then the post), not a hand-written DELETE: the
        // foreign key
        // ON DELETE CASCADE must survive it, including the self-referencing parent-child branch of comments.
        mockMvc.perform(delete("/api/v1/admin/posts/" + doomed).header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isNoContent());

        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM comments WHERE post_id = ?", Long.class, doomed))
                .isZero();
        assertThat(countLikes(doomed)).isZero();
        assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM comments WHERE id = ?", Long.class, keptComment))
                .isEqualTo(1);
        assertThat(countLikes(kept)).isEqualTo(1);
    }

    @Test
    void deleting_user_cascades_to_likes_but_fails_while_they_still_have_comments() {
        UUID post = insertDraftPost("xoa-nguoi");
        UUID liker = insertReader();
        UUID commenter = insertReader();
        jdbcTemplate.update("INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)", post, liker);
        insertComment(post, commenter, null, "this person still has comments");

        jdbcTemplate.update("DELETE FROM users WHERE id = ?", liker);
        assertThat(countLikes(post)).isZero();

        // comments.user_id is NO ACTION, like posts.author_id: the only user deletion (merging an admin account) must
        // move the comments first.
        assertThatThrownBy(() -> jdbcTemplate.update("DELETE FROM users WHERE id = ?", commenter))
                .isInstanceOf(DataIntegrityViolationException.class)
                .hasMessageContaining("comments_user_id_fkey");
    }

    // --- Entity ----------------------------------------------------------------------------------------

    @Test
    void comment_and_like_can_be_saved_through_entity_and_created_at_reads_back_as_the_in_memory_value() {
        UUID post = insertDraftPost("entity");
        UUID reader = insertReader();
        TransactionTemplate tx = new TransactionTemplate(transactionManager);

        Comment saved = tx.execute(status -> {
            Comment comment = new Comment();
            comment.setPost(entityManager.getReference(Post.class, post));
            comment.setAuthor(entityManager.getReference(User.class, reader));
            comment.setContent("saved via entity");
            entityManager.persist(comment);
            entityManager.persist(new PostLike(new PostLikeId(post, reader)));
            return comment;
        });

        // The keyset cursor compares created_at exactly to the microsecond: the in-memory value at creation must equal
        // the DB value.
        Timestamp stored = jdbcTemplate.queryForObject(
                "SELECT created_at FROM comments WHERE id = ?", Timestamp.class, saved.getId());
        assertThat(stored.toInstant()).isEqualTo(saved.getCreatedAt());
        assertThat(saved.getStatus()).isEqualTo(CommentStatus.VISIBLE);
        assertThat(jdbcTemplate.queryForObject("SELECT status FROM comments WHERE id = ?", String.class, saved.getId()))
                .isEqualTo("VISIBLE");
        assertThat(countLikes(post)).isEqualTo(1);

        Comment loaded = tx.execute(status -> {
            Comment found = entityManager.find(Comment.class, saved.getId());
            assertThat(found.getAuthor().getId()).isEqualTo(reader);
            assertThat(found.getParentId()).isNull();
            assertThat(found.getEditedAt()).isNull();
            assertThat(entityManager.find(PostLike.class, new PostLikeId(post, reader)))
                    .isNotNull();
            return found;
        });
        assertThat(loaded.getContent()).isEqualTo("saved via entity");
    }

    @Test
    void editing_comment_through_entity_writes_nothing_because_every_change_must_be_a_conditional_UPDATE() {
        UUID post = insertDraftPost("chi-doc");
        UUID reader = insertReader();
        UUID comment = insertComment(post, reader, null, "original content");
        TransactionTemplate tx = new TransactionTemplate(transactionManager);

        tx.executeWithoutResult(status -> {
            Comment managed = entityManager.find(Comment.class, comment);
            managed.setContent("overwrite via entity");
            managed.setStatus(CommentStatus.HIDDEN);
            managed.setEditedAt(Instant.now());
        });

        Map<String, Object> row =
                jdbcTemplate.queryForMap("SELECT content, status, edited_at FROM comments WHERE id = ?", comment);
        assertThat(row.get("content")).isEqualTo("original content");
        assertThat(row.get("status")).isEqualTo("VISIBLE");
        assertThat(row.get("edited_at")).isNull();
    }

    // --- Data ------------------------------------------------------------------------------------------

    private UUID insertUser(String email, String passwordHash, String role, String status, Long githubId) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO users (id, email, password_hash, display_name, role, status, github_id, "
                        + "public_slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                id,
                email,
                passwordHash,
                "Schema " + suffix,
                role,
                status,
                githubId,
                "luoc-do-" + id);
        return id;
    }

    private UUID insertReader() {
        return insertUser(null, null, "USER", "ACTIVE", auth.nextGithubId());
    }

    /** The seed admin's draft: no public page lists it. */
    private UUID insertDraftPost(String slugStem) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO posts (id, title, slug, content, status, author_id) " + "VALUES (?, ?, ?, ?, 'DRAFT', ?)",
                id,
                "Schema " + slugStem + " " + suffix,
                "luoc-do-" + slugStem + "-" + suffix,
                "Schema content " + suffix,
                SEEDED_ADMIN);
        return id;
    }

    private UUID insertComment(UUID post, UUID user, UUID parent, String content) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO comments (id, post_id, user_id, parent_id, content) VALUES (?, ?, ?, ?, ?)",
                id,
                post,
                user,
                parent,
                content);
        return id;
    }

    private long countLikes(UUID post) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM post_likes WHERE post_id = ?", Long.class, post);
    }
}
