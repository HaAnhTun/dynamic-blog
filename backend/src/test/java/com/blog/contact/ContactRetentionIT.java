package com.blog.contact;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.contact.service.ContactRetention;
import com.blog.support.AbstractIntegrationTest;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * The retention job against the real table: a message older than the default 365 days is deleted, a newer one is not, and an
 * old one that was read goes too. The DB is shared and never cleaned: only the rows of this test are looked at.
 */
class ContactRetentionIT extends AbstractIntegrationTest {

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private ContactRetention retention;

    private UUID message(OffsetDateTime createdAt, boolean read) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO contact_messages (id, name, email, message, created_at, read_at) VALUES (?, 'Retention test', ?, ?, ?, ?)",
                id,
                "retention-" + id + "@example.com",
                "A message for the retention test",
                createdAt,
                read ? createdAt : null);
        return id;
    }

    private boolean exists(UUID id) {
        return jdbcTemplate.queryForObject("SELECT count(*) FROM contact_messages WHERE id = ?", Long.class, id) == 1;
    }

    @Test
    void only_messages_older_than_the_retention_are_deleted_whether_read_or_not() {
        UUID oldUnread = message(OffsetDateTime.now().minusDays(400), false);
        UUID oldRead = message(OffsetDateTime.now().minusDays(366), true);
        UUID recent = message(OffsetDateTime.now().minusDays(364), false);
        UUID today = message(OffsetDateTime.now(), false);

        int deleted = retention.run();

        assertThat(deleted).isGreaterThanOrEqualTo(2);
        assertThat(exists(oldUnread)).isFalse();
        assertThat(exists(oldRead)).isFalse();
        assertThat(exists(recent)).isTrue();
        assertThat(exists(today)).isTrue();
    }
}
