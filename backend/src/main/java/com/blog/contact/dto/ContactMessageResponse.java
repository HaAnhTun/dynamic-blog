package com.blog.contact.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * One stored message, for the admin inbox only. Holds a visitor's personal data, so {@link #toString()} prints the id
 * and nothing else.
 *
 * @param subject nullable: the visitor may leave it out
 * @param locale  nullable: the language of the page the form was sent from
 * @param readAt  null while unread
 */
public record ContactMessageResponse(
        UUID id,
        String name,
        String email,
        String subject,
        String message,
        String locale,
        Instant createdAt,
        Instant readAt) {

    @Override
    public String toString() {
        return "ContactMessageResponse[id=" + id + "]";
    }
}
