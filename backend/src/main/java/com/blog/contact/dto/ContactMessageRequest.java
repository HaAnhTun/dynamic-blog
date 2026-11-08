package com.blog.contact.dto;

import jakarta.validation.constraints.Size;

/**
 * The public contact form: {@code {"name", "email", "subject"?, "message", "locale"?}}. Checked by ContactService, which
 * answers every bad field with one generic 400. {@link #toString()} prints nothing the visitor typed: the Spring MVC
 * DEBUG log copies the request body.
 *
 * The {@code @Size} bounds are only a coarse ceiling that is checked before the service copies a field (issue 036): the exact
 * limits (100, 150 and 5000 characters) are the service's, applied after control characters are stripped, so these leave room
 * for them. They carry the service's own message, so a field that is far too long gets the same generic 400.
 */
public record ContactMessageRequest(
        @Size(max = 200, message = "Invalid contact message")
        String name,

        @Size(max = 254, message = "Invalid contact message")
        String email,

        @Size(max = 300, message = "Invalid contact message")
        String subject,

        @Size(max = 10_000, message = "Invalid contact message")
        String message,

        @Size(max = 16, message = "Invalid contact message") String locale) {

    @Override
    public String toString() {
        return "ContactMessageRequest[<hidden>]";
    }
}
