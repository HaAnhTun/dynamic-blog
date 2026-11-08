package com.blog.newsletter.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.auth.oauth.GithubOAuthProperties;
import com.blog.common.config.SchedulingConfig;
import com.blog.common.security.ProductionMode;
import com.blog.fixtures.vi.SocialVi;
import com.blog.newsletter.config.NewsletterProperties.Transport;
import com.blog.newsletter.mail.LoggingMailTransport;
import com.blog.newsletter.mail.MailTransport;
import com.blog.newsletter.mail.SmtpMailTransport;
import com.blog.newsletter.service.NewsletterSchedule;
import com.blog.newsletter.service.NewsletterWorker;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.slf4j.LoggerFactory;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.mail.autoconfigure.MailProperties;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.scheduling.config.FixedDelayTask;
import org.springframework.scheduling.config.ScheduledTask;
import org.springframework.scheduling.config.ScheduledTaskHolder;

/**
 * Newsletter configuration, no DB needed:
 * <ul>
 *   <li>the smtp guard: a static rule, then the context itself refuses to start; the message names the variable, never the value;</li>
 *   <li>the log transport is the default and there is no JavaMailSender bean;</li>
 *   <li>the dev key, the WARN lines of a public site running the log transport; {@code toString} does not print the key;</li>
 *   <li>the worker's schedule: default, changeable, can be turned off.</li>
 * </ul>
 * Like DevJwtSecretInProductionTest: checks the rule and that the bean applies it; the rule runs while singletons are built, before Tomcat.
 */
class NewsletterConfigTest {

    private static final String SITE = "https://blog.example.com";
    private static final String FROM = "Blog <newsletter@example.com>";
    private static final String HOST = "smtp.example.com";
    private static final String SECRET = "mot-khoa-newsletter-that-dai-hon-32-byte-tu-openssl";

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(GithubOAuthProperties.class)
    @Import(NewsletterConfig.class)
    static class Beans {}

    private final ApplicationContextRunner runner = new ApplicationContextRunner().withUserConfiguration(Beans.class);

    // --- The smtp guard -------------------------------------------------------------------------------

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(
            strings = {
                "   ",
                "http://blog.example.com",
                "https://localhost",
                "https://LOCALHOST:3000",
                "https://localhost.",
                "https://app.localhost",
                "https://127.0.0.1",
                "https://127.8.9.10:8443",
                "https://[::1]:3000",
                "https://0.0.0.0",
                "https://[::]",
                "blog.example.com",
                "//blog.example.com",
                "https:blog.example.com",
                "https://",
                "https://blog example.com",
                "ftp://blog.example.com",
                "https://blog_example.com"
            })
    void site_url_that_is_not_public_https_is_rejected(String siteUrl) {
        assertRefused(siteUrl, FROM, HOST, SECRET, "SITE_URL", siteUrl);
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(
            strings = {
                "newsletter",
                "newsletter@localhost",
                "newsletter@example",
                "a@example.com, b@example.com",
                "Blog <newsletter@example.com",
                "news letter@example.com",
                SocialVi.NON_ASCII_FROM
            })
    void newsletter_from_that_is_not_a_valid_address_is_rejected(String from) {
        assertRefused(SITE, from, HOST, SECRET, "NEWSLETTER_FROM", from);
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"   "})
    void blank_smtp_host_is_rejected(String host) {
        assertRefused(SITE, FROM, host, SECRET, "SMTP_HOST", null);
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"ngan-qua", "abcdefghijklmnopqrstuvwxyz01234"})
    void newsletter_secret_under_32_bytes_is_rejected(String secret) {
        assertRefused(SITE, FROM, HOST, secret, "NEWSLETTER_SECRET", secret);
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "changemechangemechangemechangeme",
                "abcdefghijklmnopqrstuvwxyz012345",
            })
    void a_newsletter_secret_that_is_long_enough_but_guessable_is_rejected(String secret) {
        assertRefused(SITE, FROM, HOST, secret, "NEWSLETTER_SECRET", secret);
    }

    @Test
    void smtp_without_starttls_is_refused_for_a_host_that_is_not_loopback_naming_the_variable() {
        // The SMTP password and every mail (confirmation links included) would cross the network in clear text.
        for (String host : new String[] {"smtp.example.org", "203.0.113.7", "mail.localhost.example.org"}) {
            assertThatThrownBy(() -> NewsletterConfig.refuseUnsafeSmtp(SITE, FROM, host, SECRET, false, "smtp"))
                    .as(host)
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("SMTP_STARTTLS")
                    .hasMessageNotContaining(host);
        }
    }

    @Test
    void smtp_with_starttls_or_implicit_tls_or_a_loopback_host_is_accepted() {
        assertThat(NewsletterConfig.refuseUnsafeSmtp(SITE, FROM, HOST, SECRET, true, "smtp")
                        .getAddress())
                .isEqualTo("newsletter@example.com");
        // Implicit TLS (port 465) does not use STARTTLS at all.
        assertThatCode(() -> NewsletterConfig.refuseUnsafeSmtp(SITE, FROM, HOST, SECRET, false, "smtps"))
                .doesNotThrowAnyException();
        assertThatCode(() -> NewsletterConfig.refuseUnsafeSmtp(SITE, FROM, HOST, SECRET, true, "SMTPS"))
                .doesNotThrowAnyException();
        // A mail catcher on this machine is no network.
        for (String host : new String[] {"127.0.0.1", "localhost", "LOCALHOST", "[::1]", "::1"}) {
            assertThatCode(() -> NewsletterConfig.refuseUnsafeSmtp(SITE, FROM, host, SECRET, false, "smtp"))
                    .as(host)
                    .doesNotThrowAnyException();
        }
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"imap", "http", "smtp ssl", "smtpx"})
    void the_protocol_must_be_smtp_or_smtps_naming_the_variable(String protocol) {
        assertThatThrownBy(() -> NewsletterConfig.refuseUnsafeSmtp(SITE, FROM, HOST, SECRET, true, protocol))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("SMTP_PROTOCOL");
    }

    @Test
    void smtp_context_without_starttls_does_not_start_and_with_it_or_implicit_tls_does() {
        runner.withPropertyValues(
                        "app.newsletter.transport=smtp",
                        "app.oauth.github.site-url=" + SITE,
                        "app.newsletter.from=" + FROM,
                        "spring.mail.host=smtp.example.org",
                        "spring.mail.properties.mail.smtp.starttls.enable=false",
                        "spring.mail.properties.mail.smtp.starttls.required=false",
                        "app.newsletter.secret=" + SECRET)
                .run(context -> assertThat(context)
                        .hasFailed()
                        .getFailure()
                        .rootCause()
                        .hasMessageContaining("SMTP_STARTTLS")
                        .hasMessageNotContaining("smtp.example.org"));
        // STARTTLS enabled but not required can be downgraded by whoever sits on the path: also refused.
        runner.withPropertyValues(
                        "app.newsletter.transport=smtp",
                        "app.oauth.github.site-url=" + SITE,
                        "app.newsletter.from=" + FROM,
                        "spring.mail.host=smtp.example.org",
                        "spring.mail.properties.mail.smtp.starttls.enable=true",
                        "spring.mail.properties.mail.smtp.starttls.required=false",
                        "app.newsletter.secret=" + SECRET)
                .run(context -> assertThat(context).hasFailed());
        runner.withPropertyValues(
                        "app.newsletter.transport=smtp",
                        "app.oauth.github.site-url=" + SITE,
                        "app.newsletter.from=" + FROM,
                        "spring.mail.host=smtp.example.org",
                        "spring.mail.protocol=smtps",
                        "app.newsletter.secret=" + SECRET)
                .run(context -> assertThat(context).hasNotFailed());
    }

    @Test
    void application_yml_turns_starttls_on_and_names_the_settings_the_environment_variables_change() {
        runner.withInitializer(new ConfigDataApplicationContextInitializer())
                .withSystemProperties("SMTP_HOST=smtp.example.org", "SMTP_STARTTLS=false", "SMTP_PROTOCOL=smtps")
                .run(context -> {
                    MailProperties mail = context.getBean(MailProperties.class);
                    assertThat(mail.getProtocol()).isEqualTo("smtps");
                    assertThat(mail.getProperties())
                            .containsEntry("mail.smtp.starttls.enable", "false")
                            .containsEntry("mail.smtp.starttls.required", "false");
                });
        runner.withInitializer(new ConfigDataApplicationContextInitializer())
                .withSystemProperties("SMTP_HOST=smtp.example.org")
                .run(context -> {
                    MailProperties mail = context.getBean(MailProperties.class);
                    assertThat(mail.getHost()).isEqualTo("smtp.example.org");
                    assertThat(mail.getProtocol()).isEqualTo("smtp");
                    assertThat(mail.getProperties())
                            .containsEntry("mail.smtp.starttls.enable", "true")
                            .containsEntry("mail.smtp.starttls.required", "true")
                            // The server's certificate must match the host name, on STARTTLS and on implicit TLS: said
                            // here
                            // instead of left to a library default.
                            .containsEntry("mail.smtp.ssl.checkserveridentity", "true")
                            .containsEntry("mail.smtps.ssl.checkserveridentity", "true")
                            .containsEntry("mail.smtps.connectiontimeout", "10000")
                            .containsEntry("mail.smtps.timeout", "10000")
                            .containsEntry("mail.smtps.writetimeout", "10000");
                });
    }

    @Test
    void meeting_all_conditions_passes_and_returns_the_checked_sender() {
        assertThat(NewsletterConfig.refuseUnsafeSmtp(SITE, FROM, HOST, SECRET, true, "smtp")
                        .getAddress())
                .isEqualTo("newsletter@example.com");
        // 32 bytes is exactly the threshold; any public host, even a public IP; a trailing / and a path change nothing.
        assertThatCode(() -> NewsletterConfig.refuseUnsafeSmtp(
                        "https://203.0.113.7:8443/blog/",
                        "news@example.com",
                        HOST,
                        "k7Qm2xVd9RtLp4ZsW8bNc3YfJh6GuA1e",
                        true,
                        "smtp"))
                .doesNotThrowAnyException();
    }

    @Test
    void smtp_context_with_bad_configuration_does_not_start_and_error_does_not_echo_values() {
        runner.withPropertyValues(
                        "app.newsletter.transport=smtp",
                        "app.oauth.github.site-url=http://localhost:3000",
                        "app.newsletter.from=" + FROM,
                        "spring.mail.host=" + HOST,
                        "app.newsletter.secret=" + SECRET)
                .run(context -> assertThat(context)
                        .hasFailed()
                        .getFailure()
                        .rootCause()
                        .hasMessageContaining("SITE_URL")
                        .hasMessageNotContaining("localhost:3000"));
        runner.withPropertyValues(
                        "app.newsletter.transport=smtp",
                        "app.oauth.github.site-url=" + SITE,
                        "app.newsletter.from=" + FROM,
                        "spring.mail.host=" + HOST,
                        "app.newsletter.secret=ngan")
                .run(context -> assertThat(context)
                        .hasFailed()
                        .getFailure()
                        .rootCause()
                        .hasMessageContaining("NEWSLETTER_SECRET")
                        .hasMessageNotContaining("ngan"));
        // Empty key with smtp: exactly the guard's message, not the JCA "Empty key" error, whichever bean is built
        // first.
        runner.withPropertyValues(
                        "app.newsletter.transport=SMTP",
                        "app.oauth.github.site-url=" + SITE,
                        "app.newsletter.from=" + FROM,
                        "spring.mail.host=" + HOST)
                .run(context -> assertThat(context)
                        .hasFailed()
                        .getFailure()
                        .rootCause()
                        .hasMessageContaining("NEWSLETTER_SECRET"));
        // An unknown transport value does not quietly become log.
        runner.withPropertyValues("app.newsletter.transport=sendgrid")
                .run(context -> assertThat(context).hasFailed());
    }

    @Test
    void
            smtp_context_meeting_conditions_builds_SmtpMailTransport_without_opening_a_connection_and_without_JavaMailSender_bean() {
        runner.withPropertyValues(
                        "app.newsletter.transport=smtp",
                        "app.oauth.github.site-url=" + SITE,
                        "app.newsletter.from=" + FROM,
                        "spring.mail.host=smtp.invalid",
                        "spring.mail.properties.mail.smtp.starttls.enable=true",
                        "spring.mail.properties.mail.smtp.starttls.required=true",
                        "app.newsletter.secret=" + SECRET)
                .run(context -> {
                    assertThat(context).hasNotFailed();
                    assertThat(context.getBean(MailTransport.class)).isInstanceOf(SmtpMailTransport.class);
                    assertThat(context).doesNotHaveBean(JavaMailSender.class);
                });
    }

    // --- Default: log, dev key ------------------------------------------------------------------------

    @Test
    void default_is_log_transport_with_dev_key_and_no_real_mail_path() {
        runner.run(context -> {
            assertThat(context).hasNotFailed();
            assertThat(context.getBean(MailTransport.class)).isInstanceOf(LoggingMailTransport.class);
            assertThat(context).doesNotHaveBean(JavaMailSender.class);
            NewsletterProperties properties = context.getBean(NewsletterProperties.class);
            assertThat(properties.transport()).isEqualTo(Transport.LOG);
            assertThat(properties.usesDevelopmentSecret()).isTrue();
            assertThat(new String(properties.key())).isEqualTo(NewsletterProperties.DEV_SECRET);
        });
        // Even when spring.mail.host has a value: the log transport builds no sender.
        runner.withPropertyValues("spring.mail.host=" + HOST)
                .run(context -> assertThat(context).doesNotHaveBean(JavaMailSender.class));
    }

    @Test
    void toString_does_not_print_sender_or_key() {
        NewsletterProperties properties = new NewsletterProperties(Transport.SMTP, FROM, SECRET);

        assertThat(properties.toString()).contains("SMTP").doesNotContain(SECRET, "newsletter@example.com");
        assertThat(properties.usesDevelopmentSecret()).isFalse();
        assertThat(new String(properties.key())).isEqualTo(SECRET);
    }

    @Test
    void public_site_running_log_transport_warns_and_warns_once_more_with_dev_key_never_printing_the_key() {
        assertThat(warnings(SITE, new NewsletterProperties(Transport.LOG, "", "")))
                .satisfiesExactly(
                        line -> assertThat(line).contains("NEWSLETTER_TRANSPORT", "SITE_URL"),
                        line -> assertThat(line)
                                .contains("NEWSLETTER_SECRET", "SITE_URL")
                                .doesNotContain(NewsletterProperties.DEV_SECRET));
        assertThat(warnings(SITE, new NewsletterProperties(Transport.LOG, "", SECRET)))
                .singleElement()
                .satisfies(line ->
                        assertThat(line).contains("NEWSLETTER_TRANSPORT").doesNotContain(SECRET));
        // Silent: a dev machine, or smtp (NewsletterConfig already checked the key and the sender when building the
        // bean).
        assertThat(warnings("http://localhost:3000", new NewsletterProperties(Transport.LOG, "", "")))
                .isEmpty();
        assertThat(warnings(null, new NewsletterProperties(null, null, null))).isEmpty();
        assertThat(warnings(SITE, new NewsletterProperties(Transport.SMTP, FROM, SECRET)))
                .isEmpty();
    }

    // --- The worker's schedule ------------------------------------------------------------------------

    @Configuration(proxyBeanMethods = false)
    @Import(NewsletterSchedule.class)
    static class ScheduleBeans {
        @Bean
        NewsletterWorker newsletterWorker() {
            return mock(NewsletterWorker.class);
        }
    }

    private final ApplicationContextRunner scheduleRunner =
            new ApplicationContextRunner().withUserConfiguration(SchedulingConfig.class, ScheduleBeans.class);

    @Test
    void worker_runs_every_30_seconds_after_the_previous_pass_changeable_and_can_be_turned_off() {
        scheduleRunner.run(context -> assertThat(fixedDelays(context)).containsExactly(Duration.ofSeconds(30)));
        scheduleRunner
                .withPropertyValues("app.newsletter.worker-delay=2m")
                .run(context -> assertThat(fixedDelays(context)).containsExactly(Duration.ofMinutes(2)));
        scheduleRunner.withPropertyValues("app.newsletter.worker-enabled=false").run(context -> {
            assertThat(context).doesNotHaveBean(NewsletterSchedule.class);
            assertThat(fixedDelays(context)).isEmpty();
        });
    }

    private static List<Duration> fixedDelays(ApplicationContext context) {
        return context.getBeansOfType(ScheduledTaskHolder.class).values().stream()
                .flatMap(holder -> holder.getScheduledTasks().stream())
                .map(ScheduledTask::getTask)
                .filter(FixedDelayTask.class::isInstance)
                .map(task -> ((FixedDelayTask) task).getIntervalDuration())
                .toList();
    }

    /** The WARN lines of one startup. */
    private static List<String> warnings(String siteUrl, NewsletterProperties properties) {
        Logger logger = (Logger) LoggerFactory.getLogger(NewsletterWarnings.class);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        logger.addAppender(logs);
        try {
            new NewsletterWarnings(
                            properties,
                            new ProductionMode(new GithubOAuthProperties(null, null, null, siteUrl, null), true))
                    .run(new DefaultApplicationArguments());
        } finally {
            logger.detachAppender(logs);
        }
        assertThat(logs.list).allSatisfy(event -> assertThat(event.getLevel()).isEqualTo(Level.WARN));
        return logs.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
    }

    private static void assertRefused(
            String siteUrl, String from, String host, String secret, String variable, String value) {
        assertThatThrownBy(() -> NewsletterConfig.refuseUnsafeSmtp(siteUrl, from, host, secret, true, "smtp"))
                .as("%s=%s", variable, value)
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining(variable)
                .satisfies(e -> {
                    if (value != null && !value.isBlank()) {
                        assertThat(e.getMessage()).doesNotContain(value);
                    }
                });
    }
}
