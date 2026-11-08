package com.blog.newsletter.mail;

import java.util.UUID;

/**
 * A mail, plain text. Only {@code kind} and {@code id} may enter the log; every other field holds an address, a token,
 * a link carrying a token or a visitor's text, so {@link #toString()} leaves them out.
 *
 * @param id              pseudonymous id: the subscriber id (confirmation mail), the delivery id (new-post mail) or the
 *                        contact message id (contact mail)
 * @param listUnsubscribe URL of the one-click unsubscribe POST (RFC 8058), for the {@code List-Unsubscribe} header;
 *                        null for a mail that is not a newsletter mail (the contact mail)
 * @param replyTo         address for the {@code Reply-To} header; null when the mail has none
 */
public record MailMessage(
        Kind kind, UUID id, String to, String subject, String body, String listUnsubscribe, String replyTo) {

    public enum Kind {
        CONFIRMATION,
        ISSUE,
        CONTACT
    }

    /** A mail without a {@code Reply-To}: the newsletter mails. */
    public MailMessage(Kind kind, UUID id, String to, String subject, String body, String listUnsubscribe) {
        this(kind, id, to, subject, body, listUnsubscribe, null);
    }

    @Override
    public String toString() {
        return "MailMessage[kind=" + kind + ", id=" + id + "]";
    }
}
