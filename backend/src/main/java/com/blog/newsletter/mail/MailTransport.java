package com.blog.newsletter.mail;

/**
 * The only place a mail leaves the application. The default is {@link LoggingMailTransport}, which sends nothing;
 * {@link SmtpMailTransport} exists only when {@code NEWSLETTER_TRANSPORT=smtp}. Tests replace it with an in-process fake transport.
 */
public interface MailTransport {

    /** @throws MailTransportException when sending fails, carrying only a safe code */
    void send(MailMessage message);
}
