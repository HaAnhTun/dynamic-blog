package com.blog.newsletter.config;

import com.blog.auth.oauth.GithubOAuthProperties;
import com.blog.common.security.ProductionMode;
import com.blog.common.security.SecretStrength;
import com.blog.newsletter.config.NewsletterProperties.Transport;
import com.blog.newsletter.mail.LoggingMailTransport;
import com.blog.newsletter.mail.MailTransport;
import com.blog.newsletter.mail.SmtpMailTransport;
import com.blog.newsletter.service.EmailAddresses;
import com.blog.newsletter.service.NewsletterTokens;
import jakarta.mail.internet.AddressException;
import jakarta.mail.internet.InternetAddress;
import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.mail.autoconfigure.MailProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.mail.javamail.JavaMailSenderImpl;

/**
 * Newsletter mail. There is no JavaMailSender bean: the Boot auto-configuration is excluded (application.yml), and the
 * sender is built only inside {@link SmtpMailTransport}, when {@code NEWSLETTER_TRANSPORT=smtp}. So dev, IT and E2E,
 * with the default log transport, have no path that can send a real mail.
 */
@Configuration
@EnableConfigurationProperties({NewsletterProperties.class, MailProperties.class})
public class NewsletterConfig {

    static final int MIN_SECRET_BYTES = 32;

    @Bean
    public NewsletterTokens newsletterTokens(NewsletterProperties properties) {
        return new NewsletterTokens(properties.key());
    }

    /** With smtp, the safety rules run when this singleton is built: a wrong configuration stops the backend before Tomcat accepts connections. */
    @Bean
    public MailTransport mailTransport(
            NewsletterProperties newsletter, MailProperties mail, GithubOAuthProperties oauth) {
        if (newsletter.transport() == Transport.LOG) {
            return new LoggingMailTransport();
        }
        Map<String, String> settings = mail.getProperties();
        // STARTTLS counts as on only when it is enabled AND required: enabled alone lets a man in the middle strip it.
        boolean starttls = "true".equalsIgnoreCase(settings.get("mail.smtp.starttls.enable"))
                && "true".equalsIgnoreCase(settings.get("mail.smtp.starttls.required"));
        InternetAddress from = refuseUnsafeSmtp(
                oauth.siteUrl(), newsletter.from(), mail.getHost(), newsletter.secret(), starttls, mail.getProtocol());
        return new SmtpMailTransport(javaMailSender(mail), from);
    }

    /**
     * Conditions for sending real mail, static so they can be checked without a context. Stricter than ProductionMode: an
     * empty or unparseable SITE_URL is refused. Messages name the variable, never the value.
     *
     * The connection must be encrypted: STARTTLS enabled and required ({@code SMTP_STARTTLS}, port 587) or implicit TLS
     * ({@code SMTP_PROTOCOL=smtps}, port 465), unless the host is a loopback address (a mail catcher on this machine). Without
     * it the SMTP password and every mail, confirmation links included, would cross the network in clear text.
     *
     * @param starttls whether STARTTLS is both enabled and required
     * @param protocol {@code smtp} or {@code smtps}
     *
     * @return the validated sender
     * @throws IllegalStateException when a condition fails
     */
    public static InternetAddress refuseUnsafeSmtp(
            String siteUrl, String from, String smtpHost, String secret, boolean starttls, String protocol) {
        if (!isPublicHttps(siteUrl)) {
            throw new IllegalStateException("NEWSLETTER_TRANSPORT=smtp needs SITE_URL to be the site's public https "
                    + "address (not empty, not loopback, not a local name): every link in a mail is built from it, and "
                    + "a development machine must never send mail. Use NEWSLETTER_TRANSPORT=log for a local run.");
        }
        InternetAddress sender = sender(from);
        if (sender == null) {
            throw new IllegalStateException("NEWSLETTER_FROM must be one valid sender address, optionally with a "
                    + "display name (Name <address>), when NEWSLETTER_TRANSPORT=smtp; use an address on a domain your "
                    + "SMTP provider has verified.");
        }
        if (smtpHost == null || smtpHost.isBlank()) {
            throw new IllegalStateException("SMTP_HOST must be set when NEWSLETTER_TRANSPORT=smtp.");
        }
        if (secret == null || secret.getBytes(StandardCharsets.UTF_8).length < MIN_SECRET_BYTES) {
            throw new IllegalStateException("NEWSLETTER_SECRET must be at least " + MIN_SECRET_BYTES + " bytes when "
                    + "NEWSLETTER_TRANSPORT=smtp. Generate one with: openssl rand -base64 48. Never change it afterwards: "
                    + "it signs every unsubscribe link already sent.");
        }
        SecretStrength.require("NEWSLETTER_SECRET", secret, 0, "openssl rand -base64 48");
        String transport = protocol == null ? "" : protocol.strip().toLowerCase(Locale.ROOT);
        if (!transport.equals("smtp") && !transport.equals("smtps")) {
            throw new IllegalStateException("SMTP_PROTOCOL must be smtp (STARTTLS, port 587) or smtps (implicit TLS, "
                    + "port 465) when NEWSLETTER_TRANSPORT=smtp.");
        }
        if (!transport.equals("smtps") && !starttls && !ProductionMode.isLoopbackHost(smtpHost.strip())) {
            throw new IllegalStateException("SMTP_STARTTLS=false sends the SMTP password and every mail in clear text "
                    + "to a host that is not on this machine, which is refused. Keep SMTP_STARTTLS=true (port 587), or "
                    + "set SMTP_PROTOCOL=smtps and SMTP_PORT=465 for implicit TLS.");
        }
        return sender;
    }

    /** https, has a host, and the host is not loopback, {@code *.localhost} or an "all interfaces" address (0.0.0.0, ::). */
    static boolean isPublicHttps(String siteUrl) {
        if (siteUrl == null || siteUrl.isBlank()) {
            return false;
        }
        URI uri;
        try {
            uri = new URI(siteUrl.strip());
        } catch (URISyntaxException e) {
            return false;
        }
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null) {
            return false;
        }
        String name = host.toLowerCase(Locale.ROOT).replaceAll("\\.+$", "");
        if (name.equals("localhost") || name.endsWith(".localhost") || ProductionMode.isLoopbackHost(name)) {
            return false;
        }
        try {
            return !InetAddress.ofLiteral(name).isAnyLocalAddress();
        } catch (IllegalArgumentException notAnAddress) {
            return true;
        }
    }

    private static InternetAddress sender(String from) {
        if (from == null || from.isBlank()) {
            return null;
        }
        try {
            InternetAddress address = new InternetAddress(from.strip(), true);
            address.validate();
            return EmailAddresses.normalize(address.getAddress()).isPresent() ? address : null;
        } catch (AddressException e) {
            return null;
        }
    }

    private static JavaMailSenderImpl javaMailSender(MailProperties mail) {
        JavaMailSenderImpl sender = new JavaMailSenderImpl();
        sender.setHost(mail.getHost().strip());
        if (mail.getPort() != null) {
            sender.setPort(mail.getPort());
        }
        sender.setUsername(mail.getUsername());
        sender.setPassword(mail.getPassword());
        sender.setProtocol(mail.getProtocol());
        sender.setDefaultEncoding(mail.getDefaultEncoding().name());
        Properties properties = new Properties();
        properties.putAll(mail.getProperties());
        sender.setJavaMailProperties(properties);
        return sender;
    }
}
