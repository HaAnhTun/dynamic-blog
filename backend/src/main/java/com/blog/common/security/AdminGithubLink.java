package com.blog.common.security;

import com.blog.auth.service.RefreshTokenService;
import com.blog.user.service.GithubAccountService;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionException;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Links the admin account to the site owner's GitHub account at startup, when {@code ADMIN_GITHUB_ID} has a value.
 * After that, a GitHub login with that id hits {@code ON CONFLICT} on the admin row itself and receives an ADMIN token;
 * password login keeps working as before.
 *
 * <h2>Never breaks startup</h2>
 *
 * The only path that throws is a value that is not a positive integer, checked as soon as the bean is built (a bad
 * configuration must be noticed immediately). Every other case only logs:
 * <ul>
 *   <li>no admin row: WARN, nothing done;</li>
 *   <li>the admin is already linked to this very id: nothing done, no log (every startup passes through here);</li>
 *   <li>the admin is linked to a different id: WARN, left unchanged (the README has the SQL to unlink);</li>
 *   <li>the id already belongs to another ADMIN or AUTHOR: WARN, not linked;</li>
 *   <li>DB error: WARN "admin GitHub link skipped" with the error class name, the transaction rolls back, startup
 *       continues.</li>
 * </ul>
 *
 * <h2>Merging the reader account</h2>
 *
 * The most common case: the site owner first logged in with GitHub as a reader (getting a USER row), and only then set
 * {@code ADMIN_GITHUB_ID}. That USER row is merged into the admin: comments move to the admin, post likes, comment
 * likes and bookmarks move over with duplicates dropped, its notifications (sent and received) move to the admin, its
 * refresh tokens and the USER row itself are deleted, and the admin receives its id, login and avatar. This is not
 * linking accounts by email: the site owner sets this exact numeric id themselves. One WARN records the merge. The old
 * access token of the USER row (at most 15 minutes) gets 401 on its next write, because the row no longer exists.
 *
 * A real link or merge also ends every session the admin account had ({@link RefreshTokenService#revokeAllSessions}:
 * refresh tokens revoked, access tokens issued so far rejected through {@code users.tokens_valid_after}): the account
 * gained a way in, and nothing opened before that change outlives it. A startup that finds the link already in place
 * changes nothing, so a restart signs nobody out.
 *
 * Every step runs in one transaction, after the {@code pg_advisory_xact_lock} shared with GithubAccountService: a login
 * with the same id cannot run in between. {@code @Order(15)}: after AdminSeedEmail (5) and AdminPasswordFromEnvironment
 * (10), before DevCredentialWarning (20).
 */
@Component
@Order(15)
public class AdminGithubLink implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(AdminGithubLink.class);

    private final Long githubId;
    private final String adminEmail;
    private final JdbcTemplate jdbcTemplate;
    private final RefreshTokenService refreshTokenService;
    private final TransactionTemplate transactionTemplate;

    public AdminGithubLink(
            AdminAccountProperties properties,
            JdbcTemplate jdbcTemplate,
            RefreshTokenService refreshTokenService,
            PlatformTransactionManager transactionManager) {
        // Validated as soon as the bean is built: a wrong ADMIN_GITHUB_ID is the only startup failure this class
        // causes.
        this.githubId = properties.linkedGithubId();
        this.adminEmail = properties.email();
        this.jdbcTemplate = jdbcTemplate;
        this.refreshTokenService = refreshTokenService;
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    @Override
    public void run(ApplicationArguments args) {
        if (githubId == null) {
            return;
        }
        Runnable report;
        try {
            report = transactionTemplate.execute(status -> link(githubId));
        } catch (DataAccessException | TransactionException e) {
            log.warn("admin GitHub link skipped: {}", e.getClass().getName());
            return;
        }
        // Logged after the commit, not inside the transaction: a merge is only reported once it has really happened.
        if (report != null) {
            report.run();
        }
    }

    private Runnable link(long id) {
        GithubAccountService.lockGithubId(jdbcTemplate, id);

        List<Account> admins = jdbcTemplate.query(
                "SELECT id, github_id FROM users WHERE email = ? AND role = 'ADMIN' FOR UPDATE",
                (rs, row) -> new Account(rs.getObject("id", UUID.class), rs.getObject("github_id", Long.class)),
                adminEmail);
        if (admins.isEmpty()) {
            return () -> log.warn("ADMIN_GITHUB_ID is set but the admin row (app.admin.email, role ADMIN) was not "
                    + "found; not linking.");
        }
        Account admin = admins.getFirst();
        if (admin.githubId() != null) {
            if (admin.githubId() == id) {
                return null;
            }
            return () -> log.warn("admin already linked to a different GitHub id; not changing it. "
                    + "README \"Link the admin account to GitHub\" has the SQL to unlink it first.");
        }

        List<Owner> owners = jdbcTemplate.query(
                "SELECT id, role, status, github_login, avatar_url FROM users WHERE github_id = ? FOR UPDATE",
                (rs, row) -> new Owner(
                        rs.getObject("id", UUID.class),
                        rs.getString("role"),
                        rs.getString("status"),
                        rs.getString("github_login"),
                        rs.getString("avatar_url")),
                id);
        if (owners.isEmpty()) {
            jdbcTemplate.update("UPDATE users SET github_id = ?, updated_at = now() WHERE id = ?", id, admin.id());
            refreshTokenService.revokeAllSessions(admin.id(), Instant.now());
            return () -> log.info("admin account linked to GitHub id {}", id);
        }
        Owner owner = owners.getFirst();
        if (!"USER".equals(owner.role())) {
            return () -> log.warn("GitHub id {} belongs to another privileged account; not linking.", id);
        }
        return merge(admin.id(), owner, id);
    }

    /**
     * Merges the reader row that holds this id into the admin, in this exact order: comments (comments.user_id is
     * NO ACTION, so they must be moved before the row is deleted), post likes (dropping posts the admin already liked),
     * comment likes and bookmarks (likewise), notifications ({@link #moveNotifications}), refresh tokens, the USER row,
     * and only then writing the id onto the admin (UNIQUE on github_id: the old row must go first).
     *
     * comment_likes, post_bookmarks and notifications have a user foreign key with ON DELETE CASCADE: they must be moved
     * before the statement that deletes the USER row, otherwise the delete silently takes them along.
     */
    private Runnable merge(UUID adminId, Owner reader, long id) {
        int comments = jdbcTemplate.update("UPDATE comments SET user_id = ? WHERE user_id = ?", adminId, reader.id());
        int likes = jdbcTemplate.update(
                "INSERT INTO post_likes (post_id, user_id, created_at) "
                        + "SELECT post_id, ?, created_at FROM post_likes WHERE user_id = ? ON CONFLICT DO NOTHING",
                adminId,
                reader.id());
        jdbcTemplate.update("DELETE FROM post_likes WHERE user_id = ?", reader.id());
        int commentLikes = jdbcTemplate.update(
                "INSERT INTO comment_likes (comment_id, user_id, created_at) "
                        + "SELECT comment_id, ?, created_at FROM comment_likes WHERE user_id = ? ON CONFLICT DO NOTHING",
                adminId,
                reader.id());
        jdbcTemplate.update("DELETE FROM comment_likes WHERE user_id = ?", reader.id());
        int bookmarks = jdbcTemplate.update(
                "INSERT INTO post_bookmarks (user_id, post_id, created_at) "
                        + "SELECT ?, post_id, created_at FROM post_bookmarks WHERE user_id = ? ON CONFLICT DO NOTHING",
                adminId,
                reader.id());
        jdbcTemplate.update("DELETE FROM post_bookmarks WHERE user_id = ?", reader.id());
        int notifications = moveNotifications(adminId, reader.id());
        jdbcTemplate.update("DELETE FROM refresh_tokens WHERE user_id = ?", reader.id());
        jdbcTemplate.update("DELETE FROM users WHERE id = ?", reader.id());
        jdbcTemplate.update(
                "UPDATE users SET github_id = ?, github_login = ?, avatar_url = ?, updated_at = now() "
                        + "WHERE id = ?",
                id,
                reader.githubLogin(),
                reader.avatarUrl(),
                adminId);
        refreshTokenService.revokeAllSessions(adminId, Instant.now());
        // WARN, not INFO: an account just disappeared. The old status is logged because a suspended reader is merged
        // too: from now on that id is an ADMIN identity.
        return () -> log.warn(
                "merged GitHub reader account into admin: githubId={} oldUserId={} oldStatus={} "
                        + "comments={} likes={} commentLikes={} bookmarks={} notifications={}",
                id,
                reader.id(),
                reader.status(),
                comments,
                likes,
                commentLikes,
                bookmarks,
                notifications);
    }

    /**
     * The notifications of the USER row. Its comments and likes have become the admin's, so the notifications about them
     * do too: other readers keep in their inbox the times the site owner replied or liked, and the old reader's inbox
     * becomes the admin's. Only rows that would become self-notifications (CHECK chk_notifications_not_self) are dropped,
     * together with like notifications that duplicate one the admin already has (the unique indexes
     * uq_notifications_*_liked). Comment likes were moved earlier, so a moved like notification still has the like
     * behind it, and still shows.
     *
     * @return the number of notifications moved to the admin (as actor, then as recipient)
     */
    private int moveNotifications(UUID adminId, UUID readerId) {
        jdbcTemplate.update(
                "DELETE FROM notifications WHERE (recipient_id = ? AND actor_id = ?) "
                        + "OR (recipient_id = ? AND actor_id = ?)",
                readerId,
                adminId,
                adminId,
                readerId);
        int asActor = jdbcTemplate.update("""
                UPDATE notifications n SET actor_id = ?
                WHERE n.actor_id = ?
                  AND NOT (n.type IN ('POST_LIKED', 'COMMENT_LIKED') AND EXISTS (
                      SELECT 1 FROM notifications o
                      WHERE o.actor_id = ? AND o.recipient_id = n.recipient_id AND o.type = n.type
                        AND o.post_id = n.post_id AND o.comment_id IS NOT DISTINCT FROM n.comment_id))""", adminId, readerId, adminId);
        int asRecipient = jdbcTemplate.update("""
                UPDATE notifications n SET recipient_id = ?
                WHERE n.recipient_id = ?
                  AND NOT (n.type IN ('POST_LIKED', 'COMMENT_LIKED') AND EXISTS (
                      SELECT 1 FROM notifications o
                      WHERE o.recipient_id = ? AND o.actor_id = n.actor_id AND o.type = n.type
                        AND o.post_id = n.post_id AND o.comment_id IS NOT DISTINCT FROM n.comment_id))""", adminId, readerId, adminId);
        // Whatever rows of the old reader remain are the duplicates skipped above.
        jdbcTemplate.update("DELETE FROM notifications WHERE recipient_id = ? OR actor_id = ?", readerId, readerId);
        return asActor + asRecipient;
    }

    private record Account(UUID id, Long githubId) {}

    private record Owner(UUID id, String role, String status, String githubLogin, String avatarUrl) {}
}
