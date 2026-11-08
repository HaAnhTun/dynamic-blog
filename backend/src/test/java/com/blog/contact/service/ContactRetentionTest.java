package com.blog.contact.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.blog.contact.config.ContactRetentionProperties;
import com.blog.contact.repository.ContactMessageRepository;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.Test;

/** The retention job without a database: which cutoff it asks for, and that 0 means nothing is ever deleted. */
class ContactRetentionTest {

    private static final Instant NOW = Instant.parse("2026-10-24T03:43:00Z");
    private final ContactMessageRepository repository = mock(ContactMessageRepository.class);
    private final Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);

    @Test
    void it_deletes_what_arrived_before_the_configured_number_of_days_ago() {
        when(repository.deleteCreatedBefore(Instant.parse("2026-09-24T03:43:00Z")))
                .thenReturn(3);

        assertThat(new ContactRetention(repository, new ContactRetentionProperties(30), clock).run())
                .isEqualTo(3);
    }

    @Test
    void zero_days_keeps_every_message_and_touches_nothing() {
        assertThat(new ContactRetention(repository, new ContactRetentionProperties(0), clock).run())
                .isZero();

        verify(repository, never()).deleteCreatedBefore(org.mockito.ArgumentMatchers.any());
    }

    @Test
    void a_negative_number_is_refused() {
        assertThatThrownBy(() -> new ContactRetentionProperties(-1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.contact.retention.days");
    }
}
