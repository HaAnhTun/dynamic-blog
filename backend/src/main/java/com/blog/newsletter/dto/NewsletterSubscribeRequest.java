package com.blog.newsletter.dto;

import jakarta.validation.constraints.Size;

/**
 * {@code {"email": "...", "locale": "en"}}; the locale is optional (absent means the default locale).
 * {@link #toString()} does not print the address: the Spring MVC DEBUG log copies the request body.
 *
 * The bounds (an address is at most 254 characters, a locale code a few) are checked before the service copies the field
 * (issue 036); the service still decides what is a usable address.
 */
public record NewsletterSubscribeRequest(
        @Size(max = 254, message = "Invalid email address") String email,
        @Size(max = 16, message = "Invalid locale") String locale) {

    @Override
    public String toString() {
        return "NewsletterSubscribeRequest[email=<hidden>]";
    }
}
