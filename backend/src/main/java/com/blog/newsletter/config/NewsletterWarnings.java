package com.blog.newsletter.config;

import com.blog.common.security.ProductionMode;
import com.blog.newsletter.config.NewsletterProperties.Transport;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

/**
 * Two startup WARN lines for a public site ({@link ProductionMode}) running the newsletter with the log transport, like
 * ViewsTokenWarning: they do not refuse startup, because log is a valid state before there is a mail provider; with
 * smtp, NewsletterConfig has already checked everything. Never prints the key.
 */
@Component
@RequiredArgsConstructor
public class NewsletterWarnings implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(NewsletterWarnings.class);

    private final NewsletterProperties properties;
    private final ProductionMode productionMode;

    @Override
    public void run(ApplicationArguments args) {
        if (!productionMode.active() || properties.transport() != Transport.LOG) {
            return;
        }
        log.warn("NEWSLETTER_TRANSPORT is log while SITE_URL is a public address: signups are accepted but no mail is "
                + "sent, and the admin newsletter page counts every mail as sent. Configure an SMTP provider and set "
                + "NEWSLETTER_TRANSPORT=smtp.");
        if (properties.usesDevelopmentSecret()) {
            log.warn("NEWSLETTER_SECRET is empty while SITE_URL is a public address: unsubscribe links and "
                    + "suppression hashes use the development key committed to this repository. Set NEWSLETTER_SECRET "
                    + "(openssl rand -base64 48) before the first subscriber: changing it later invalidates every "
                    + "unsubscribe link already sent and every suppression entry.");
        }
    }
}
