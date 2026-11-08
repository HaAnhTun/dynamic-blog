package com.blog.user.service;

import com.blog.auth.oauth.GithubProfile;
import com.blog.search.sync.SearchOutbox;
import com.blog.user.entity.UserStatus;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.ResultSetExtractor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Finds or creates the account for a GitHub login.
 *
 * The identity is GitHub's numeric id, not the login (which can change) and never the email: the same id always maps to
 * the same row, even when the person changes their login, and a GitHub user carrying the admin's email is still just a
 * separate reader. The GitHub email is never written.
 *
 * A single {@code INSERT … ON CONFLICT (github_id) DO UPDATE … RETURNING} statement, no read-then-write: two
 * simultaneous first logins of one id still produce one row. It writes with SQL instead of the entity because the
 * GitHub columns, the status and the login time are read-only on User.
 */
@Service
@RequiredArgsConstructor
public class GithubAccountService {

    /** A lock shared with AdminGithubLink: an admin link never runs in between a login of the same id. */
    private static final String LOCK_SQL =
            "SELECT pg_advisory_xact_lock(hashtext('github-id'), hashtext(CAST(? AS text)))";

    /**
     * Creates a new USER reader, or updates the row that already has that id: the login and avatar always follow GitHub,
     * while the display name only follows GitHub when the row is a USER (a linked ADMIN or AUTHOR keeps the name managed
     * in the CMS). {@code xmax = 0} is only true for a row just INSERTed, not for one just UPDATEd.
     *
     * A suspended row is not updated at all ({@code WHERE users.status = 'ACTIVE'}): a rejected login must not change
     * the name, login or avatar that the person's still-visible comments carry, nor record a login time. In that case
     * the statement returns no row (Postgres still locks the conflicting row) and {@link #EXISTING_SQL} reads it back.
     *
     * {@code public_slug} is only written on INSERT, never in DO UPDATE: changing the GitHub login does not change the
     * profile path. The value in VALUES must still be valid even on conflict (NOT NULL and CHECK are verified first), so
     * for an existing row it is that row's own slug.
     */
    private static final String UPSERT_SQL = """
            INSERT INTO users (id, github_id, github_login, display_name, avatar_url, role, status, public_slug,
                               created_at, updated_at, last_login_at)
            VALUES (gen_random_uuid(), ?, ?, ?, ?, 'USER', 'ACTIVE', ?, now(), now(), now())
            ON CONFLICT (github_id) DO UPDATE SET
                github_login  = EXCLUDED.github_login,
                avatar_url    = EXCLUDED.avatar_url,
                display_name  = CASE WHEN users.role = 'USER' THEN EXCLUDED.display_name ELSE users.display_name END,
                last_login_at = now(),
                updated_at    = now()
            WHERE users.status = 'ACTIVE'
            RETURNING id, status, (xmax = 0) AS created, display_name
            """;

    /** The existing row of the GitHub id that the upsert did not update because it is not ACTIVE. */
    private static final String EXISTING_SQL = "SELECT id, status FROM users WHERE github_id = ?";

    /** The slug and name of the existing row: if the name changes, the author's search document and their posts' must be re-synced. */
    private static final String EXISTING_SLUG_SQL = "SELECT public_slug, display_name FROM users WHERE github_id = ?";

    private final JdbcTemplate jdbcTemplate;
    private final SearchOutbox searchOutbox;

    private record Existing(String slug, String displayName) {}

    private record Upserted(UserLogin login, String displayName) {}

    /**
     * The result of a GitHub login.
     *
     * @param userId  id of the users row
     * @param status  the status; the caller rejects SUSPENDED
     * @param created true when this login created the account
     */
    public record UserLogin(UUID userId, UserStatus status, boolean created) {}

    /**
     * Records a GitHub login. A suspended account is not written at all (see {@link #UPSERT_SQL}) and is only returned
     * with its status: the caller (GithubOAuth2UserService) rejects it with 403 USER_SUSPENDED.
     */
    @Transactional
    public UserLogin recordLogin(GithubProfile profile) {
        lockGithubId(jdbcTemplate, profile.id());
        // Under the GitHub id lock nobody else can add a row with this id (AdminGithubLink takes the same lock), so
        // "no row yet" here is certain: only that path takes the global slug lock.
        Optional<Existing> existing = jdbcTemplate
                .query(
                        EXISTING_SLUG_SQL,
                        (rs, row) -> new Existing(rs.getString("public_slug"), rs.getString("display_name")),
                        profile.id())
                .stream()
                .findFirst();
        String slug = existing.map(Existing::slug)
                .orElseGet(() ->
                        PublicSlugs.allocate(jdbcTemplate, PublicSlugs.baseOf(profile.login(), profile.displayName())));
        List<Upserted> upserted = jdbcTemplate.query(
                UPSERT_SQL,
                (rs, row) -> new Upserted(
                        new UserLogin(
                                rs.getObject("id", UUID.class),
                                UserStatus.valueOf(rs.getString("status")),
                                rs.getBoolean("created")),
                        rs.getString("display_name")),
                profile.id(),
                profile.login(),
                profile.displayName(),
                profile.avatarUrl(),
                slug);
        if (!upserted.isEmpty()) {
            Upserted result = upserted.getFirst();
            // Under the GitHub id lock nobody else writes this row: the name read above is the name right before the
            // upsert. The avatar is in no search document, so it does not count.
            if (existing.isPresent() && !Objects.equals(existing.get().displayName(), result.displayName())) {
                searchOutbox.authorAndPublishedPosts(result.login().userId());
            }
            return result.login();
        }
        // Conflict with a non-ACTIVE row: the upsert only locked that row and wrote nothing. Read its id and status
        // back.
        return jdbcTemplate.queryForObject(
                EXISTING_SQL,
                (rs, row) -> new UserLogin(
                        rs.getObject("id", UUID.class), UserStatus.valueOf(rs.getString("status")), false),
                profile.id());
    }

    /**
     * A transaction-scoped lock for a GitHub id, released when the transaction ends. It MUST run inside a transaction:
     * outside one, the lock is released as soon as the statement finishes and holds nothing.
     */
    public static void lockGithubId(JdbcTemplate jdbcTemplate, long githubId) {
        jdbcTemplate.query(LOCK_SQL, (ResultSetExtractor<Void>) rs -> null, githubId);
    }
}
