package com.blog.contact.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Contact form, bound from {@code app.contact.*}. {@link #toString()} does not print the address.
 *
 * @param recipient {@code CONTACT_RECIPIENT}: the address that receives a copy of every message by mail; empty (the
 *                  default) means the messages are only stored and read in the admin inbox
 */
@ConfigurationProperties("app.contact")
public record ContactProperties(String recipient) {

    public ContactProperties {
        recipient = recipient == null ? "" : recipient.strip();
    }

    @Override
    public String toString() {
        return "ContactProperties[recipient=" + (recipient.isEmpty() ? "<empty>" : "<set>") + "]";
    }
}
