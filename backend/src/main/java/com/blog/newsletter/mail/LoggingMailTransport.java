package com.blog.newsletter.mail;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The default transport: sends nothing. One INFO line per mail, with only the mail kind and a pseudonymous id: no
 * address, subject, link or token.
 */
public class LoggingMailTransport implements MailTransport {

    private static final Logger log = LoggerFactory.getLogger(LoggingMailTransport.class);

    @Override
    public void send(MailMessage message) {
        log.info("mail not sent (NEWSLETTER_TRANSPORT=log): kind={} id={}", message.kind(), message.id());
    }
}
