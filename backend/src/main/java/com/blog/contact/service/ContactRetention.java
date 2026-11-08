package com.blog.contact.service;

import com.blog.contact.config.ContactRetentionProperties;
import com.blog.contact.repository.ContactMessageRepository;
import java.time.Clock;
import java.time.Duration;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Deletes the contact messages older than {@code app.contact.retention.days} (default 365), every night. A message is personal data
 * (a name, an address, free text) kept only so that the administrator can read and answer it, so it does not stay for ever. The run
 * time is {@code app.contact.retention.cron}, default 03:43 every day in the JVM's time zone (UTC); {@code -} turns the job off, and
 * so does {@code days = 0}. A single DELETE: running it twice, or on two instances, is harmless. The log has only the row count.
 */
@Component
@RequiredArgsConstructor
public class ContactRetention {

    private static final Logger log = LoggerFactory.getLogger(ContactRetention.class);

    /** 03:43 every day; the default of {@code app.contact.retention.cron}. */
    static final String DEFAULT_CRON = "0 43 3 * * *";

    private final ContactMessageRepository repository;
    private final ContactRetentionProperties properties;
    private final Clock clock;

    /**
     * The run time is the setting, or {@link #DEFAULT_CRON} when it is absent or left empty: a bare {@code CONTACT_RETENTION_CRON=}
     * line in a .env file outside Docker Compose reaches the application as an empty value, which would otherwise stop the start.
     *
     * @return the number of messages deleted
     */
    @Scheduled(
            cron = "#{'${app.contact.retention.cron:}'.trim().isEmpty() ? '" + DEFAULT_CRON
                    + "' : '${app.contact.retention.cron:}'.trim()}")
    public int run() {
        if (properties.days() == 0) {
            return 0;
        }
        int deleted = repository.deleteCreatedBefore(clock.instant().minus(Duration.ofDays(properties.days())));
        log.info("contact retention: {} message(s) older than {} days deleted", deleted, properties.days());
        return deleted;
    }
}
