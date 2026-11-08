package com.blog.newsletter.repository;

import com.blog.newsletter.dto.NewsletterStatsResponse.IssueStatus;
import com.blog.newsletter.dto.NewsletterStatsResponse.NewsletterFailureCount;
import com.blog.newsletter.dto.NewsletterStatsResponse.NewsletterIssueStats;
import com.blog.newsletter.dto.NewsletterStatsResponse.NewsletterSubscriberCounts;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Every SQL statement of the newsletter (V31). Timestamps always come from the application {@code Clock}, not from the
 * DB {@code now()}, so token expiry, retention and the retry schedule share one clock. The worker's row-locking
 * statements use {@code SKIP LOCKED}: two workers (or two instances) never process the same row.
 */
@Repository
@RequiredArgsConstructor
public class NewsletterRepository {

    private static final String DUE_CONFIRMATION = """
            status = 'PENDING' AND (confirmation_sent_at IS NULL OR confirmation_sent_at < confirmation_requested_at)""";
    private static final String DUE_DELIVERY = """
            d.status IN ('PENDING', 'RETRYING') AND d.next_attempt_at <= ? AND p.status = 'PUBLISHED'""";

    private final JdbcTemplate jdbcTemplate;

    /** The subscriber a token points to, with the language of their mail. */
    public record Subscriber(UUID id, String email, String locale) {
        @Override
        public String toString() {
            return "Subscriber[id=" + id + "]";
        }
    }

    /** A pending subscriber, found by the hash of the confirmation token. */
    public record PendingToken(UUID id, String email, Instant expiresAt) {
        @Override
        public String toString() {
            return "PendingToken[id=" + id + "]";
        }
    }

    /** A new-post mail that is due, with what is needed to write the mail. */
    public record DueDelivery(
            UUID id,
            int attempts,
            UUID subscriberId,
            String email,
            String locale,
            String slug,
            String title,
            String excerpt) {
        @Override
        public String toString() {
            return "DueDelivery[id=" + id + "]";
        }
    }

    // --- Subscribe, confirm, unsubscribe ----------------------------------------------------------------

    /**
     * One statement for every state: not yet present, insert as PENDING; pending, mark that a fresh confirmation mail is
     * needed and take the new locale; already confirmed, change nothing (a stranger cannot change the language of a
     * confirmed subscriber). No prior read, so there is no read-then-write race and a unique violation never happens.
     */
    public void requestConfirmation(String email, String locale, Instant now) {
        jdbcTemplate.update("""
                INSERT INTO newsletter_subscribers (email, status, confirmation_requested_at, created_at, locale)
                VALUES (?, 'PENDING', ?, ?, ?)
                ON CONFLICT (email) DO UPDATE SET confirmation_requested_at = EXCLUDED.confirmation_requested_at,
                    locale = EXCLUDED.locale
                WHERE newsletter_subscribers.status = 'PENDING'""", email, at(now), at(now), locale);
    }

    public Optional<PendingToken> lockPendingByTokenHash(String tokenHash) {
        return jdbcTemplate
                .query(
                        """
                SELECT id, email, confirmation_expires_at FROM newsletter_subscribers
                WHERE confirmation_token_hash = ? AND status = 'PENDING' FOR UPDATE""",
                        (rs, row) -> new PendingToken(
                                uuid(rs, "id"), rs.getString("email"), instant(rs, "confirmation_expires_at")),
                        tokenHash)
                .stream()
                .findFirst();
    }

    public void confirm(UUID id, Instant now) {
        jdbcTemplate.update("""
                UPDATE newsletter_subscribers SET status = 'CONFIRMED', confirmed_at = ?, confirmation_requested_at = NULL,
                    confirmation_sent_at = NULL, confirmation_token_hash = NULL, confirmation_expires_at = NULL
                WHERE id = ?""", at(now), id);
    }

    public Optional<Subscriber> lockSubscriber(UUID id) {
        return jdbcTemplate
                .query(
                        "SELECT id, email, locale FROM newsletter_subscribers WHERE id = ? FOR UPDATE",
                        (rs, row) -> new Subscriber(uuid(rs, "id"), rs.getString("email"), rs.getString("locale")),
                        id)
                .stream()
                .findFirst();
    }

    public void suppress(String emailHash, Instant now) {
        jdbcTemplate.update("""
                INSERT INTO newsletter_suppressions (email_hash, created_at) VALUES (?, ?)
                ON CONFLICT (email_hash) DO NOTHING""", emailHash, at(now));
    }

    public void unsuppress(String emailHash) {
        jdbcTemplate.update("DELETE FROM newsletter_suppressions WHERE email_hash = ?", emailHash);
    }

    public boolean isSuppressed(String emailHash) {
        return Boolean.TRUE.equals(jdbcTemplate.queryForObject(
                "SELECT EXISTS (SELECT 1 FROM newsletter_suppressions WHERE email_hash = ?)",
                Boolean.class,
                emailHash));
    }

    /** The mails of this subscriber go with them (ON DELETE CASCADE). */
    public void deleteSubscriber(UUID id) {
        jdbcTemplate.update("DELETE FROM newsletter_subscribers WHERE id = ?", id);
    }

    // --- First publish ----------------------------------------------------------------------------------

    /**
     * @param held true for a post published by someone who is not an ADMIN: the issue waits (HELD) until an ADMIN releases
     *             it; false queues it (PENDING) as soon as the worker runs
     */
    public void insertIssue(UUID postId, boolean held, Instant now) {
        jdbcTemplate.update("""
                INSERT INTO newsletter_issues (post_id, status, created_at) VALUES (?, ?, ?)
                ON CONFLICT (post_id) DO NOTHING""", postId, held ? "HELD" : "PENDING", at(now));
    }

    /** A held issue and the text of its post as it stands now. */
    public record HeldIssue(
            UUID postId,
            String slug,
            String title,
            String excerpt,
            String language,
            String authorName,
            Instant heldAt,
            boolean published,
            long recipients) {}

    /** Held issues, oldest first, with how many confirmed subscribers of the post language would get the mail. */
    public List<HeldIssue> heldIssues(int limit) {
        return jdbcTemplate.query("""
                SELECT i.post_id, p.slug, p.title, p.excerpt, p.language, u.display_name, i.created_at,
                       (p.status = 'PUBLISHED') AS published,
                       (SELECT count(*) FROM newsletter_subscribers s
                        WHERE s.status = 'CONFIRMED' AND s.locale = p.language) AS recipients
                FROM newsletter_issues i
                JOIN posts p ON p.id = i.post_id
                LEFT JOIN users u ON u.id = p.author_id
                WHERE i.status = 'HELD'
                ORDER BY i.created_at, i.post_id LIMIT ?""", (rs, row) -> heldIssue(rs), limit);
    }

    /** Locks one held issue with its post; empty when it is not held (decided already, or no such issue). */
    public Optional<HeldIssue> lockHeldIssue(UUID postId) {
        return jdbcTemplate.query("""
                SELECT i.post_id, p.slug, p.title, p.excerpt, p.language, u.display_name, i.created_at,
                       (p.status = 'PUBLISHED') AS published, 0 AS recipients
                FROM newsletter_issues i
                JOIN posts p ON p.id = i.post_id
                LEFT JOIN users u ON u.id = p.author_id
                WHERE i.post_id = ? AND i.status = 'HELD'
                FOR UPDATE OF i""", (rs, row) -> heldIssue(rs), postId).stream()
                .findFirst();
    }

    /**
     * HELD to PENDING, keeping what the administrator approved: the subject, the excerpt and the language as they were when
     * they released it. The worker mails that text to the subscribers of that language, not whatever the post says later.
     */
    public void release(
            UUID postId,
            UUID adminId,
            String approvedTitle,
            String approvedExcerpt,
            String approvedLanguage,
            Instant now) {
        jdbcTemplate.update("""
                UPDATE newsletter_issues
                SET status = 'PENDING', decided_at = ?, decided_by = ?, approved_title = ?, approved_excerpt = ?,
                    approved_language = ?
                WHERE post_id = ? AND status = 'HELD'""", at(now), adminId, approvedTitle, approvedExcerpt, approvedLanguage, postId);
    }

    /** HELD to DISCARDED: kept as a record, never mailed. */
    public void discard(UUID postId, UUID adminId, Instant now) {
        jdbcTemplate.update("""
                UPDATE newsletter_issues SET status = 'DISCARDED', decided_at = ?, decided_by = ?
                WHERE post_id = ? AND status = 'HELD'""", at(now), adminId, postId);
    }

    private static HeldIssue heldIssue(ResultSet rs) throws SQLException {
        return new HeldIssue(
                uuid(rs, "post_id"),
                rs.getString("slug"),
                rs.getString("title"),
                rs.getString("excerpt"),
                rs.getString("language"),
                rs.getString("display_name"),
                instant(rs, "created_at"),
                rs.getBoolean("published"),
                rs.getLong("recipients"));
    }

    // --- Worker -----------------------------------------------------------------------------------------

    /** Unconfirmed subscriptions whose most recent request was before {@code cutoff}. */
    public int deleteStalePending(Instant cutoff, int limit) {
        return jdbcTemplate.update("""
                DELETE FROM newsletter_subscribers WHERE id IN (
                    SELECT id FROM newsletter_subscribers
                    WHERE status = 'PENDING' AND confirmation_requested_at < ?
                    LIMIT ? FOR UPDATE SKIP LOCKED)""", at(cutoff), limit);
    }

    public List<UUID> dueConfirmations(int limit) {
        return jdbcTemplate.queryForList(
                "SELECT id FROM newsletter_subscribers WHERE " + DUE_CONFIRMATION
                        + " ORDER BY confirmation_requested_at, id LIMIT ?",
                UUID.class,
                limit);
    }

    /** Locks a row that still needs a confirmation mail; empty when it was already handled or is held by another worker. */
    public Optional<Subscriber> lockDueConfirmation(UUID id) {
        return jdbcTemplate
                .query(
                        "SELECT id, email, locale FROM newsletter_subscribers WHERE id = ? AND " + DUE_CONFIRMATION
                                + " FOR UPDATE SKIP LOCKED",
                        (rs, row) -> new Subscriber(uuid(rs, "id"), rs.getString("email"), rs.getString("locale")),
                        id)
                .stream()
                .findFirst();
    }

    /** The new hash replaces the old one: only the token of the latest confirmation mail works. */
    public void markConfirmationSent(UUID id, String tokenHash, Instant expiresAt, Instant now) {
        jdbcTemplate.update("""
                UPDATE newsletter_subscribers
                SET confirmation_token_hash = ?, confirmation_expires_at = ?, confirmation_sent_at = ?
                WHERE id = ?""", tokenHash, at(expiresAt), at(now), id);
    }

    /** An issue not yet expanded, for a post that is currently published; if the post is taken down, the issue waits until it is published again. */
    public List<UUID> pendingIssues(int limit) {
        return jdbcTemplate.queryForList("""
                SELECT i.post_id FROM newsletter_issues i JOIN posts p ON p.id = i.post_id
                WHERE i.status = 'PENDING' AND p.status = 'PUBLISHED'
                ORDER BY i.created_at, i.post_id LIMIT ?""", UUID.class, limit);
    }

    public boolean lockPendingIssue(UUID postId) {
        return !jdbcTemplate.queryForList("""
                SELECT post_id FROM newsletter_issues WHERE post_id = ? AND status = 'PENDING'
                FOR UPDATE SKIP LOCKED""", UUID.class, postId).isEmpty();
    }

    /**
     * One delivery per confirmed subscriber whose locale is the language of the post (the one an administrator approved
     * when the issue was released, else the one the post has); the unique key (post_id, subscriber_id) skips those that
     * already exist.
     */
    public int expand(UUID postId, Instant now) {
        return jdbcTemplate.update("""
                INSERT INTO newsletter_deliveries (post_id, subscriber_id, status, attempts, next_attempt_at, created_at)
                SELECT p.id, s.id, 'PENDING', 0, ?, ? FROM posts p
                JOIN newsletter_issues i ON i.post_id = p.id
                JOIN newsletter_subscribers s ON s.locale = COALESCE(i.approved_language, p.language)
                                             AND s.status = 'CONFIRMED'
                WHERE p.id = ?
                ON CONFLICT (post_id, subscriber_id) DO NOTHING""", at(now), at(now), postId);
    }

    public void markExpanded(UUID postId, Instant now) {
        jdbcTemplate.update(
                "UPDATE newsletter_issues SET status = 'EXPANDED', expanded_at = ? WHERE post_id = ?", at(now), postId);
    }

    /** Due mails of a published post; if the post is taken down, its mails wait until it is published again. */
    public List<UUID> dueDeliveries(Instant now, int limit) {
        return jdbcTemplate.queryForList(
                "SELECT d.id FROM newsletter_deliveries d JOIN posts p ON p.id = d.post_id" + " WHERE " + DUE_DELIVERY
                        + " ORDER BY d.next_attempt_at, d.id LIMIT ?",
                UUID.class,
                at(now),
                limit);
    }

    public Optional<DueDelivery> lockDueDelivery(UUID id, Instant now) {
        return jdbcTemplate
                .query(
                        """
                SELECT d.id, d.attempts, s.id AS subscriber_id, s.email, s.locale, p.slug,
                       COALESCE(i.approved_title, p.title) AS title,
                       CASE WHEN i.approved_title IS NOT NULL THEN i.approved_excerpt ELSE p.excerpt END AS excerpt
                FROM newsletter_deliveries d
                JOIN newsletter_issues i ON i.post_id = d.post_id
                JOIN newsletter_subscribers s ON s.id = d.subscriber_id
                JOIN posts p ON p.id = d.post_id
                WHERE d.id = ? AND\s""" + DUE_DELIVERY + " FOR UPDATE OF d SKIP LOCKED",
                        (rs, row) -> new DueDelivery(
                                uuid(rs, "id"),
                                rs.getInt("attempts"),
                                uuid(rs, "subscriber_id"),
                                rs.getString("email"),
                                rs.getString("locale"),
                                rs.getString("slug"),
                                rs.getString("title"),
                                rs.getString("excerpt")),
                        id,
                        at(now))
                .stream()
                .findFirst();
    }

    public void markSent(UUID id, Instant now) {
        jdbcTemplate.update("UPDATE newsletter_deliveries SET status = 'SENT', sent_at = ? WHERE id = ?", at(now), id);
    }

    /** @param status RETRYING or DEAD; {@code code} is a safe code (the V31 CHECK accepts only uppercase letters and _) */
    public void markFailed(UUID id, String status, int attempts, Instant nextAttemptAt, String code) {
        jdbcTemplate.update("""
                UPDATE newsletter_deliveries SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?
                WHERE id = ?""", status, attempts, at(nextAttemptAt), code, id);
    }

    // --- Figures for the admin --------------------------------------------------------------------------

    public NewsletterSubscriberCounts subscriberCounts() {
        return jdbcTemplate.queryForObject(
                """
                SELECT count(*) FILTER (WHERE status = 'PENDING') AS pending,
                       count(*) FILTER (WHERE status = 'CONFIRMED') AS confirmed
                FROM newsletter_subscribers""", (rs, row) -> new NewsletterSubscriberCounts(rs.getLong("pending"), rs.getLong("confirmed")));
    }

    public long suppressedCount() {
        Long count = jdbcTemplate.queryForObject("SELECT count(*) FROM newsletter_suppressions", Long.class);
        return count == null ? 0 : count;
    }

    public List<NewsletterIssueStats> latestIssues(int limit) {
        return jdbcTemplate.query(
                """
                SELECT i.post_id, p.slug, p.title, i.created_at, i.status,
                       count(d.id) FILTER (WHERE d.status = 'SENT') AS sent,
                       count(d.id) FILTER (WHERE d.status = 'RETRYING') AS retrying,
                       count(d.id) FILTER (WHERE d.status = 'DEAD') AS dead,
                       count(d.id) FILTER (WHERE d.status = 'PENDING') AS pending
                FROM (SELECT post_id, created_at, status FROM newsletter_issues
                      ORDER BY created_at DESC, post_id DESC LIMIT ?) i
                JOIN posts p ON p.id = i.post_id
                LEFT JOIN newsletter_deliveries d ON d.post_id = i.post_id
                GROUP BY i.post_id, p.slug, p.title, i.created_at, i.status
                ORDER BY i.created_at DESC, i.post_id DESC""",
                (rs, row) -> new NewsletterIssueStats(
                        uuid(rs, "post_id"),
                        rs.getString("slug"),
                        rs.getString("title"),
                        instant(rs, "created_at"),
                        IssueStatus.valueOf(rs.getString("status")),
                        rs.getLong("sent"),
                        rs.getLong("retrying"),
                        rs.getLong("dead"),
                        rs.getLong("pending")),
                limit);
    }

    public List<NewsletterFailureCount> failures() {
        return jdbcTemplate.query(
                """
                SELECT last_error, count(*) AS count FROM newsletter_deliveries
                WHERE status IN ('RETRYING', 'DEAD')
                GROUP BY last_error ORDER BY count(*) DESC, last_error""", (rs, row) -> new NewsletterFailureCount(rs.getString("last_error"), rs.getLong("count")));
    }

    private static OffsetDateTime at(Instant instant) {
        return OffsetDateTime.ofInstant(instant, ZoneOffset.UTC);
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        OffsetDateTime value = rs.getObject(column, OffsetDateTime.class);
        return value == null ? null : value.toInstant();
    }

    private static UUID uuid(ResultSet rs, String column) throws SQLException {
        return rs.getObject(column, UUID.class);
    }
}
