package com.blog.contact.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * How long a contact message is kept, bound from {@code app.contact.retention.*} ({@code CONTACT_RETENTION_DAYS}). A message holds a
 * visitor's name, email address and free text, so it is not kept forever by default: a nightly job
 * ({@code ContactRetention}) deletes the messages older than this many days, read or not. {@code 0} turns the job off and keeps
 * every message until an administrator deletes it. A negative number stops the application from starting. A setting left empty
 * ({@code CONTACT_RETENTION_DAYS=} in a .env file outside Docker Compose) has the default, like one that is not set.
 *
 * @param days days a message is kept, counted from the day it arrived; 0 means until deleted by hand
 */
@ConfigurationProperties("app.contact.retention")
public record ContactRetentionProperties(
        @DefaultValue("365") Integer days) {

    public ContactRetentionProperties {
        if (days < 0) {
            throw new IllegalArgumentException(
                    "app.contact.retention.days is invalid: " + days + " (0 keeps every message)");
        }
    }
}
