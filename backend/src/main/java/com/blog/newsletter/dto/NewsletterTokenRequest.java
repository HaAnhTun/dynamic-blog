package com.blog.newsletter.dto;

/** {@code {"token": "..."}} of confirm and unsubscribe. {@link #toString()} does not print the token. */
public record NewsletterTokenRequest(String token) {

    @Override
    public String toString() {
        return "NewsletterTokenRequest[token=<hidden>]";
    }
}
