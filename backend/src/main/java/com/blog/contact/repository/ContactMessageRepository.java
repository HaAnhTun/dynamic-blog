package com.blog.contact.repository;

import com.blog.contact.dto.ContactMessageResponse;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * Every SQL statement of the contact form (V42). Timestamps come from the application {@code Clock}, like the
 * newsletter, so the per-address window and the tests share one clock.
 */
@Repository
@RequiredArgsConstructor
public class ContactMessageRepository {

    private final JdbcTemplate jdbcTemplate;

    /**
     * Stores the message unless the address already has {@code maxPerWindow} messages created at or after
     * {@code windowStart}. The address is compared in lower case. Count and insert run in one transaction under a
     * transaction-level advisory lock on the address, so parallel requests from one address cannot both slip under the
     * limit; the lock is released at commit.
     *
     * @return {@code false} (and nothing stored) when the address is over the limit
     */
    @Transactional
    public boolean insertUnlessLimited(
            UUID id,
            String name,
            String email,
            String subject,
            String message,
            String locale,
            Instant now,
            Instant windowStart,
            int maxPerWindow) {
        jdbcTemplate.queryForRowSet("SELECT pg_advisory_xact_lock(hashtext('contact:' || lower(?)))", email);
        Integer recent = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM contact_messages WHERE lower(email) = lower(?) AND created_at >= ?",
                Integer.class,
                email,
                at(windowStart));
        if (recent != null && recent >= maxPerWindow) {
            return false;
        }
        jdbcTemplate.update("""
                INSERT INTO contact_messages (id, name, email, subject, message, locale, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)""", id, name, email, subject, message, locale, at(now));
        return true;
    }

    /** Newest first. */
    public List<ContactMessageResponse> list(int limit, long offset) {
        return jdbcTemplate.query("""
                SELECT id, name, email, subject, message, locale, created_at, read_at
                FROM contact_messages ORDER BY created_at DESC, id LIMIT ? OFFSET ?""", this::row, limit, offset);
    }

    public long count() {
        Long total = jdbcTemplate.queryForObject("SELECT count(*) FROM contact_messages", Long.class);
        return total == null ? 0 : total;
    }

    public long unreadCount() {
        Long total =
                jdbcTemplate.queryForObject("SELECT count(*) FROM contact_messages WHERE read_at IS NULL", Long.class);
        return total == null ? 0 : total;
    }

    /** Keeps the first read time when the message is already read. @return whether a message with that id exists */
    public boolean markRead(UUID id, Instant now) {
        return jdbcTemplate.update(
                        "UPDATE contact_messages SET read_at = COALESCE(read_at, ?) WHERE id = ?", at(now), id)
                > 0;
    }

    /** The retention job: every message that arrived before {@code cutoff}, read or not. @return how many were deleted */
    public int deleteCreatedBefore(Instant cutoff) {
        return jdbcTemplate.update("DELETE FROM contact_messages WHERE created_at < ?", at(cutoff));
    }

    /** @return whether a message with that id existed */
    public boolean delete(UUID id) {
        return jdbcTemplate.update("DELETE FROM contact_messages WHERE id = ?", id) > 0;
    }

    private ContactMessageResponse row(ResultSet rs, int rowNum) throws SQLException {
        return new ContactMessageResponse(
                rs.getObject("id", UUID.class),
                rs.getString("name"),
                rs.getString("email"),
                rs.getString("subject"),
                rs.getString("message"),
                rs.getString("locale"),
                instant(rs.getObject("created_at", OffsetDateTime.class)),
                instant(rs.getObject("read_at", OffsetDateTime.class)));
    }

    private static Instant instant(OffsetDateTime value) {
        return value == null ? null : value.toInstant();
    }

    private static OffsetDateTime at(Instant instant) {
        return instant.atOffset(ZoneOffset.UTC);
    }
}
