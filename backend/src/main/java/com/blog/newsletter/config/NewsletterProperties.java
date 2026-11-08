package com.blog.newsletter.config;

import java.nio.charset.StandardCharsets;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * Newsletter, bound from {@code app.newsletter.*}. {@code worker-enabled} and {@code worker-delay} are read directly in
 * NewsletterSchedule, not through this record. {@link #toString()} prints neither the sender nor the key.
 *
 * @param transport {@code NEWSLETTER_TRANSPORT}: log (default, sends nothing) or smtp
 * @param from      {@code NEWSLETTER_FROM}: the sender; required only with smtp
 * @param secret    {@code NEWSLETTER_SECRET}: the HMAC key of the unsubscribe link and the suppression hash
 */
@ConfigurationProperties("app.newsletter")
public record NewsletterProperties(Transport transport, String from, String secret) {

    /**
     * The key when {@code NEWSLETTER_SECRET} is empty and the transport is log: dev machines, IT and E2E need to set
     * nothing. With smtp an empty key makes the backend refuse to start (NewsletterConfig), so this key never signs a
     * link that is sent out.
     */
    public static final String DEV_SECRET = "dev-only-newsletter-secret-change-me-at-least-32-bytes";

    public enum Transport {
        LOG,
        SMTP
    }

    public NewsletterProperties {
        transport = transport == null ? Transport.LOG : transport;
        from = from == null ? "" : from.strip();
        secret = secret == null ? "" : secret.strip();
    }

    /** Whether {@link #DEV_SECRET} is in use. */
    public boolean usesDevelopmentSecret() {
        return secret.isEmpty() && transport == Transport.LOG;
    }

    /** Bytes of the HMAC key. Empty with smtp and an empty key; NewsletterConfig refuses to start before it is used. */
    public byte[] key() {
        return (usesDevelopmentSecret() ? DEV_SECRET : secret).getBytes(StandardCharsets.UTF_8);
    }

    @Override
    public String toString() {
        return "NewsletterProperties[transport=" + transport + ", from=" + (from.isEmpty() ? "<empty>" : "<set>")
                + ", secret=" + (secret.isEmpty() ? "<empty>" : "<set>") + "]";
    }
}
