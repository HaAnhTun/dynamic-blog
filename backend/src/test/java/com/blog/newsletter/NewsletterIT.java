package com.blog.newsletter;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.ThrowableProxyUtil;
import ch.qos.logback.core.read.ListAppender;
import com.blog.comment.CommentFixtures;
import com.blog.comment.CommentFixtures.Post;
import com.blog.comment.CommentFixtures.Reader;
import com.blog.newsletter.mail.LoggingMailTransport;
import com.blog.newsletter.mail.MailFailure;
import com.blog.newsletter.mail.MailMessage;
import com.blog.newsletter.mail.MailMessage.Kind;
import com.blog.newsletter.mail.MailTransport;
import com.blog.newsletter.mail.MailTransportException;
import com.blog.newsletter.service.NewsletterTokens;
import com.blog.newsletter.service.NewsletterWorker;
import com.blog.support.AbstractIntegrationTest;
import com.blog.support.AuthTestSupport;
import com.blog.support.HeldTransaction;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.ApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.context.support.ResourceBundleMessageSource;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.PlatformTransactionManager;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Newsletter on a database of its own: global counts (subscribers, issues, deliveries) are only right
 * when no other class writes to it, and the worker processes EVERY due row. At the start of each test the four newsletter tables of this DB are cleared.
 *
 * The transport is an in-process fake ({@link CapturingMailTransport}, {@code @Primary}): no mail leaves the machine. The clock is
 * {@link TestClock}, pushed by hand to check token expiry, the retention period and the retry schedule. The worker's schedule is off; tests call
 * {@link NewsletterWorker#runOnce()} directly. SITE_URL is localhost: links in mails are absolute URLs, and still point at the dev machine.
 */
@SpringBootTest
@AutoConfigureMockMvc
@Import({AuthTestSupport.class, NewsletterIT.TestBeans.class})
@TestPropertySource(
        properties = {
            "app.oauth.github.client-id=",
            "app.oauth.github.client-secret=",
            "app.oauth.github.redirect-uri=",
            "app.oauth.github.site-url=" + NewsletterIT.SITE,
            "app.admin.github-id=",
            "app.security.refresh-token-cleanup-cron=-",
            "app.newsletter.worker-enabled=false",
            "app.search.worker-enabled=false",
            "app.search.reconcile-cron=-"
        })
class NewsletterIT {

    static final String SITE = "http://localhost:3000";
    private static final String SUBSCRIPTIONS = "/api/v1/newsletter/subscriptions";
    private static final String CONFIRM = "/api/v1/newsletter/confirm";
    private static final String UNSUBSCRIBE = "/api/v1/newsletter/unsubscribe";
    private static final String STATS = "/api/v1/admin/newsletter";
    private static final Pattern CONFIRM_LINK =
            Pattern.compile(Pattern.quote(SITE + "/newsletter/confirm?token=") + "([A-Za-z0-9_-]+)");
    private static final Pattern ONE_CLICK =
            Pattern.compile(Pattern.quote(SITE + "/api/newsletter/unsubscribe?token=") + "([A-Za-z0-9_-]+)");
    /** The wait before retry number 1 to 5. */
    private static final List<Duration> BACKOFF = List.of(
            Duration.ofMinutes(1),
            Duration.ofMinutes(5),
            Duration.ofMinutes(30),
            Duration.ofHours(2),
            Duration.ofHours(12));

    @DynamicPropertySource
    static void isolatedDatabase(DynamicPropertyRegistry registry) {
        AbstractIntegrationTest.useFreshDatabase(registry, "newsletter_it");
    }

    /** Records every mail instead of sending it, or throws according to {@link #failure}. Failed sends are counted too. */
    static final class CapturingMailTransport implements MailTransport {
        final List<MailMessage> sent = new CopyOnWriteArrayList<>();
        final AtomicInteger attempts = new AtomicInteger();
        volatile Function<MailMessage, MailFailure> failure = message -> null;

        @Override
        public void send(MailMessage message) {
            attempts.incrementAndGet();
            MailFailure failed = failure.apply(message);
            if (failed != null) {
                throw new MailTransportException(failed);
            }
            sent.add(message);
        }

        List<MailMessage> to(String email, Kind kind) {
            return sent.stream()
                    .filter(m -> m.to().equals(email) && m.kind() == kind)
                    .toList();
        }
    }

    /** A clock pushed by hand, with microsecond precision like timestamptz. */
    static final class TestClock extends Clock {
        private volatile Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);

        void reset() {
            now = Instant.now().truncatedTo(ChronoUnit.MICROS);
        }

        void advance(Duration duration) {
            now = now.plus(duration);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return Clock.fixed(now, zone);
        }

        @Override
        public Instant instant() {
            return now;
        }
    }

    @TestConfiguration(proxyBeanMethods = false)
    static class TestBeans {
        @Bean
        @Primary
        CapturingMailTransport capturingMailTransport() {
            return new CapturingMailTransport();
        }

        @Bean
        @Primary
        TestClock testClock() {
            return new TestClock();
        }
    }

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper objectMapper;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private AuthTestSupport auth;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private ApplicationContext context;

    @Autowired
    private NewsletterWorker worker;

    @Autowired
    private NewsletterTokens tokens;

    @Autowired
    private CapturingMailTransport transport;

    @Autowired
    private TestClock clock;

    private CommentFixtures f;

    @BeforeEach
    void cleanSlate() {
        // The statements below delete all newsletter data: only ever on this class's own DB.
        assertThat(jdbcTemplate.queryForObject("SELECT current_database()", String.class))
                .isEqualTo("newsletter_it");
        jdbcTemplate.update("DELETE FROM newsletter_issues");
        jdbcTemplate.update("DELETE FROM newsletter_subscribers");
        jdbcTemplate.update("DELETE FROM newsletter_suppressions");
        transport.sent.clear();
        transport.attempts.set(0);
        transport.failure = message -> null;
        clock.reset();
        f = new CommentFixtures(mockMvc, objectMapper, jdbcTemplate, auth);
    }

    // --- The whole cycle ------------------------------------------------------------------------------

    @Test
    void subscribe_confirm_publish_receive_mail_then_unsubscribe_without_login_and_no_address_or_token_reaches_the_log()
            throws Exception {
        String email = address("tron-vong");
        Logger root = (Logger) LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        List<String> secrets = new ArrayList<>(List.of(email));
        try {
            // Subscribe, with whitespace and capitals: stored in the canonical form. The request sends nothing, creates
            // no token.
            assertThat(body(subscribe("  " + email.toUpperCase() + " ").andExpect(status().isAccepted())))
                    .isEqualTo("{\"data\":{\"status\":\"PENDING_CONFIRMATION\"}}");
            assertThat(transport.attempts).hasValue(0);
            UUID subscriberId = subscriberId(email);
            assertThat(column(email, "status")).isEqualTo("PENDING");
            assertThat(column(email, "confirmation_token_hash")).isNull();

            // The worker sends the confirmation mail (the first time the mail server is down: the error log line is
            // also part of the test's final check): the
            // confirm link, the unsubscribe link, the one-click header. The DB holds only the SHA-256 of the token.
            transport.failure = message -> MailFailure.CONNECTION_FAILED;
            worker.runOnce();
            transport.failure = message -> null;
            worker.runOnce();
            MailMessage confirmation = single(email, Kind.CONFIRMATION);
            String token = confirmationToken(confirmation);
            String unsubscribeToken = oneClickToken(confirmation);
            secrets.addAll(List.of(token, unsubscribeToken, NewsletterTokens.sha256Hex(token)));
            assertThat(confirmation.id()).isEqualTo(subscriberId);
            assertThat(confirmation.body()).contains(SITE + "/newsletter/unsubscribe?token=" + unsubscribeToken);
            assertThat(column(email, "confirmation_token_hash")).isEqualTo(NewsletterTokens.sha256Hex(token));
            assertThat(timestamp(email, "confirmation_expires_at"))
                    .isEqualTo(clock.instant().plus(Duration.ofHours(48)));
            assertThat(count("SELECT count(*) FROM newsletter_subscribers WHERE confirmation_token_hash = ?", token))
                    .isZero();
            worker.runOnce();
            assertThat(transport.sent).hasSize(1);

            assertThat(body(confirm(token).andExpect(status().isOk())))
                    .isEqualTo("{\"data\":{\"status\":\"CONFIRMED\"}}");
            assertThat(column(email, "status")).isEqualTo("CONFIRMED");
            assertThat(column(email, "confirmation_token_hash")).isNull();

            // Publish a new post: the publish request does not touch the transport; the outbox has exactly one pending
            // issue.
            int attempts = transport.attempts.get();
            Post post = f.publishedPost("New post for subscribers");
            assertThat(transport.attempts).hasValue(attempts);
            assertThat(jdbcTemplate.queryForObject(
                            "SELECT status FROM newsletter_issues WHERE post_id = ?", String.class, post.id()))
                    .isEqualTo("PENDING");

            // The worker splits out the issue and sends exactly one mail (the first time it is refused, retried after 1
            // minute): the title, the summary, the canonical
            // URL, the unsubscribe link and the header.
            transport.failure = message -> MailFailure.REJECTED;
            worker.runOnce();
            transport.failure = message -> null;
            clock.advance(Duration.ofMinutes(1));
            worker.runOnce();
            MailMessage issue = single(email, Kind.ISSUE);
            String title = "New post for subscribers " + f.suffix;
            assertThat(issue.subject()).isEqualTo(title);
            assertThat(issue.body())
                    .contains(
                            title,
                            "Summary " + f.suffix,
                            SITE + "/posts/" + post.slug(),
                            SITE + "/newsletter/unsubscribe?token=" + unsubscribeToken);
            assertThat(issue.listUnsubscribe())
                    .isEqualTo(SITE + "/api/newsletter/unsubscribe?token=" + unsubscribeToken);
            assertThat(deliveryStatuses(post)).containsExactly("SENT");
            worker.runOnce();
            assertThat(transport.to(email, Kind.ISSUE)).hasSize(1);

            // Unsubscribing needs no login, both times 200: the address disappears, only the blocking hash remains.
            for (int i = 0; i < 2; i++) {
                assertThat(body(unsubscribe(unsubscribeToken).andExpect(status().isOk())))
                        .isEqualTo("{\"data\":{\"status\":\"UNSUBSCRIBED\"}}");
            }
            assertThat(count("SELECT count(*) FROM newsletter_subscribers WHERE email = ?", email))
                    .isZero();
            assertThat(count("SELECT count(*) FROM newsletter_deliveries WHERE subscriber_id = ?", subscriberId))
                    .isZero();
            assertThat(count(
                            "SELECT count(*) FROM newsletter_suppressions WHERE email_hash = ?",
                            tokens.suppressionHash(email)))
                    .isEqualTo(1);
            // A fake or malformed token: one generic answer.
            f.assertError(unsubscribe(NewsletterTokens.newConfirmationToken()), 400, "NEWSLETTER_TOKEN_INVALID");
            f.assertError(unsubscribe("ngan"), 400, "NEWSLETTER_TOKEN_INVALID");
        } finally {
            root.detachAppender(logs);
        }

        assertThat(logs.list).isNotEmpty();
        for (ILoggingEvent event : logs.list) {
            String line = event.getFormattedMessage()
                    + (event.getThrowableProxy() == null ? "" : ThrowableProxyUtil.asString(event.getThrowableProxy()));
            for (String secret : secrets) {
                assertThat(line.toLowerCase()).as(event.getLoggerName()).doesNotContain(secret.toLowerCase());
            }
            assertThat(line).as(event.getLoggerName()).doesNotContain("token=");
        }
    }

    @Test
    void application_has_no_JavaMailSender_bean_and_configured_transport_is_log() {
        // application.yml sets spring.mail.host (empty), which is enough for Boot's auto-configuration to build a
        // sender: it is excluded.
        assertThat(context.getBeanNamesForType(JavaMailSender.class)).isEmpty();
        assertThat(context.getBean("mailTransport")).isInstanceOf(LoggingMailTransport.class);
    }

    // --- Confirmation token -----------------------------------------------------------------------------

    @Test
    void confirmation_token_expires_after_48_hours_is_single_use_and_new_mail_replaces_old_token() throws Exception {
        String email = address("het-han");
        subscribe(email).andExpect(status().isAccepted());
        worker.runOnce();
        String first = confirmationToken(single(email, Kind.CONFIRMATION));

        clock.advance(Duration.ofHours(48));
        String expired = f.assertError(confirm(first), 400, "NEWSLETTER_TOKEN_INVALID")
                .path("message")
                .asString();
        assertThat(column(email, "status")).isEqualTo("PENDING");

        // Subscribe again: a new mail with a new token; the old token is still unusable.
        subscribe(email).andExpect(status().isAccepted());
        worker.runOnce();
        List<MailMessage> mails = transport.to(email, Kind.CONFIRMATION);
        assertThat(mails).hasSize(2);
        String second = confirmationToken(mails.get(1));
        assertThat(second).isNotEqualTo(first);
        f.assertError(confirm(first), 400, "NEWSLETTER_TOKEN_INVALID");

        // One second before expiry it can still be used; used a second time it cannot.
        clock.advance(Duration.ofHours(48).minusSeconds(1));
        confirm(second).andExpect(status().isOk());
        String reused = f.assertError(confirm(second), 400, "NEWSLETTER_TOKEN_INVALID")
                .path("message")
                .asString();
        String unknown = f.assertError(
                        confirm(NewsletterTokens.newConfirmationToken()), 400, "NEWSLETTER_TOKEN_INVALID")
                .path("message")
                .asString();
        f.assertError(confirm("sai dang!"), 400, "NEWSLETTER_TOKEN_INVALID");
        assertThat(List.of(expired, reused, unknown)).containsOnly("The link is invalid or has expired");
    }

    // --- Cannot probe who is subscribed ------------------------------------------------------------------

    @Test
    void
            every_well_formed_address_gets_the_same_answer_byte_for_byte_whether_new_pending_confirmed_unsubscribed_or_over_limit()
                    throws Exception {
        String fresh = address("moi");
        String pending = address("dang-cho");
        String confirmed = address("da-xac-nhan");
        String unsubscribed = address("da-huy");
        String limited = address("qua-han-muc");
        subscribe(pending).andExpect(status().isAccepted());
        insertConfirmed(confirmed);
        UUID gone = insertConfirmed(unsubscribed);
        unsubscribe(tokens.unsubscribeToken(gone)).andExpect(status().isOk());
        for (int i = 0; i < 3; i++) {
            subscribe(limited).andExpect(status().isAccepted());
        }
        Instant beforeLimit = timestamp(limited, "confirmation_requested_at");
        clock.advance(Duration.ofMinutes(1));

        Map<String, MockHttpServletResponse> responses = new LinkedHashMap<>();
        for (String email : List.of(fresh, pending, confirmed, unsubscribed, limited)) {
            responses.put(email, subscribe(email).andReturn().getResponse());
        }
        MockHttpServletResponse reference = responses.get(fresh);
        assertThat(reference.getStatus()).isEqualTo(202);
        for (Map.Entry<String, MockHttpServletResponse> response : responses.entrySet()) {
            assertThat(response.getValue().getStatus()).isEqualTo(202);
            assertThat(response.getValue().getContentAsByteArray()).isEqualTo(reference.getContentAsByteArray());
            assertThat(headers(response.getValue())).isEqualTo(headers(reference));
            assertThat(response.getValue().getContentAsString()).doesNotContain(response.getKey());
        }

        // Inside they differ, and no request sends a mail.
        Instant now = clock.instant();
        assertThat(column(fresh, "status")).isEqualTo("PENDING");
        assertThat(timestamp(pending, "confirmation_requested_at")).isEqualTo(now);
        assertThat(column(confirmed, "status")).isEqualTo("CONFIRMED");
        assertThat(timestamp(confirmed, "confirmation_requested_at")).isNull();
        assertThat(column(unsubscribed, "status")).isEqualTo("PENDING");
        assertThat(subscriberId(unsubscribed)).isNotEqualTo(gone);
        assertThat(count(
                        "SELECT count(*) FROM newsletter_suppressions WHERE email_hash = ?",
                        tokens.suppressionHash(unsubscribed)))
                .isEqualTo(1);
        assertThat(timestamp(limited, "confirmation_requested_at")).isEqualTo(beforeLimit);
        assertThat(transport.attempts).hasValue(0);
    }

    @Test
    void limit_of_3_per_hour_counts_on_the_normalized_address_and_over_limit_attempt_queues_no_mail() throws Exception {
        String email = address("gioi-han");
        for (String variant : List.of(email, email.toUpperCase(), "  " + email + "\t")) {
            clock.advance(Duration.ofMinutes(1));
            subscribe(variant).andExpect(status().isAccepted());
            worker.runOnce();
        }
        assertThat(transport.to(email, Kind.CONFIRMATION)).hasSize(3);
        Instant third = timestamp(email, "confirmation_requested_at");

        clock.advance(Duration.ofMinutes(1));
        subscribe(email).andExpect(status().isAccepted());
        worker.runOnce();
        assertThat(transport.to(email, Kind.CONFIRMATION)).hasSize(3);
        assertThat(timestamp(email, "confirmation_requested_at")).isEqualTo(third);
    }

    @Test
    void
            more_than_20_confirms_or_unsubscribes_for_one_address_in_an_hour_is_429_and_unknown_token_counts_against_nobody()
                    throws Exception {
        String email = address("han-muc-token");
        subscribe(email).andExpect(status().isAccepted());
        worker.runOnce();
        String token = confirmationToken(single(email, Kind.CONFIRMATION));
        clock.advance(Duration.ofHours(49));

        for (int i = 0; i < 20; i++) {
            f.assertError(confirm(token), 400, "NEWSLETTER_TOKEN_INVALID");
        }
        f.assertError(confirm(token), 429, "RATE_LIMITED");
        // The same limit applies to unsubscribing the same address: it cannot be unsubscribed yet, the row remains.
        f.assertError(unsubscribe(tokens.unsubscribeToken(subscriberId(email))), 429, "RATE_LIMITED");
        assertThat(column(email, "status")).isEqualTo("PENDING");
        // An unknown token points to no address: still the generic answer, and it does not get anyone else blocked.
        f.assertError(confirm(NewsletterTokens.newConfirmationToken()), 400, "NEWSLETTER_TOKEN_INVALID");
        String other = address("han-muc-token-khac");
        unsubscribe(tokens.unsubscribeToken(insertConfirmed(other))).andExpect(status().isOk());
    }

    // --- Blocking row -----------------------------------------------------------------------------------

    @Test
    void after_unsubscribing_subscribing_again_requires_confirming_again_and_no_mail_reaches_a_blocked_address()
            throws Exception {
        String email = address("chan");
        // Unsubscribing straight from the confirmation mail's link: the pending subscription is also deleted and
        // blocked.
        subscribe(email).andExpect(status().isAccepted());
        worker.runOnce();
        unsubscribe(oneClickToken(single(email, Kind.CONFIRMATION))).andExpect(status().isOk());
        assertThat(count("SELECT count(*) FROM newsletter_subscribers WHERE email = ?", email))
                .isZero();
        String suppression = tokens.suppressionHash(email);
        assertThat(count("SELECT count(*) FROM newsletter_suppressions WHERE email_hash = ?", suppression))
                .isEqualTo(1);

        // Subscribe again: pending, receiving no post until it is confirmed; confirming drops the blocking row.
        clock.advance(Duration.ofMinutes(1));
        subscribe(email).andExpect(status().isAccepted());
        assertThat(column(email, "status")).isEqualTo("PENDING");
        Post beforeConfirming = f.publishedPost("Post before reconfirmation");
        worker.runOnce();
        assertThat(transport.to(email, Kind.CONFIRMATION)).hasSize(2);
        assertThat(transport.to(email, Kind.ISSUE)).isEmpty();
        assertThat(deliveryStatuses(beforeConfirming)).isEmpty();
        confirm(confirmationToken(transport.to(email, Kind.CONFIRMATION).get(1)))
                .andExpect(status().isOk());
        assertThat(count("SELECT count(*) FROM newsletter_suppressions WHERE email_hash = ?", suppression))
                .isZero();

        // Extra defense: a confirmed address that has a blocking row receives no mail, the delivery becomes
        // DEAD/SUPPRESSED.
        String blocked = address("chan-khac");
        insertConfirmed(blocked);
        jdbcTemplate.update(
                "INSERT INTO newsletter_suppressions (email_hash) VALUES (?)", tokens.suppressionHash(blocked));
        Post after = f.publishedPost("Post after reconfirmation");
        worker.runOnce();
        assertThat(transport.to(email, Kind.ISSUE))
                .singleElement()
                .satisfies(mail -> assertThat(mail.body()).contains("/posts/" + after.slug()));
        assertThat(transport.sent).noneMatch(mail -> mail.to().equals(blocked));
        assertThat(jdbcTemplate.queryForList("""
                SELECT d.status || ' ' || d.last_error FROM newsletter_deliveries d
                JOIN newsletter_subscribers s ON s.id = d.subscriber_id WHERE s.email = ?""", String.class, blocked)).containsExactly("DEAD SUPPRESSED");
    }

    // --- First publish ----------------------------------------------------------------------------------

    @Test
    void only_first_publish_creates_an_issue_draft_edit_unpublish_republish_and_restore_revision_do_not()
            throws Exception {
        Post post = f.draftPost("Post tracking an issue");
        edit(post, "Edited draft content " + f.suffix);
        assertThat(issues(post)).isZero();

        f.republish(post);
        assertThat(issues(post)).isEqualTo(1);
        OffsetDateTime created = jdbcTemplate.queryForObject(
                "SELECT created_at FROM newsletter_issues WHERE post_id = ?", OffsetDateTime.class, post.id());

        clock.advance(Duration.ofMinutes(5));
        edit(post, "Content edited after publishing " + f.suffix);
        f.unpublish(post);
        f.republish(post);
        String revisions = body(mockMvc.perform(get("/api/v1/admin/posts/" + post.id() + "/revisions")
                        .header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk()));
        String revision =
                objectMapper.readTree(revisions).path("data").get(0).path("id").asString();
        mockMvc.perform(post("/api/v1/admin/posts/" + post.id() + "/revisions/" + revision + "/restore")
                        .header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk());

        assertThat(issues(post)).isEqualTo(1);
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT created_at FROM newsletter_issues WHERE post_id = ?", OffsetDateTime.class, post.id()))
                .isEqualTo(created);
        // Deleting the post takes the issue with it.
        f.deletePost(post);
        assertThat(issues(post)).isZero();
    }

    @Test
    void two_simultaneous_first_publishes_create_exactly_one_issue_and_one_publishedAt() throws Exception {
        Post post = f.draftPost("Post published twice at once");
        String admin = auth.bearerForAdmin();
        ExecutorService pool = Executors.newFixedThreadPool(2);
        List<Future<MockHttpServletResponse>> responses = new ArrayList<>();
        try (HeldTransaction row = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForList("SELECT id FROM posts WHERE id = ? FOR UPDATE", post.id()))) {
            for (int i = 0; i < 2; i++) {
                responses.add(pool.submit(() -> mockMvc.perform(post("/api/v1/admin/posts/" + post.id() + "/publish")
                                .header("Authorization", admin))
                        .andReturn()
                        .getResponse()));
            }
            // Both have reached the post-read statement under the lock of PostService.publish and are waiting: a real
            // race.
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "for no key update", 2);
            row.commit();
            List<String> publishedAt = new ArrayList<>();
            for (Future<MockHttpServletResponse> response : responses) {
                MockHttpServletResponse done = response.get(30, TimeUnit.SECONDS);
                assertThat(done.getStatus()).as(done.getContentAsString()).isEqualTo(200);
                publishedAt.add(objectMapper
                        .readTree(done.getContentAsString())
                        .path("data")
                        .path("publishedAt")
                        .asString());
            }
            assertThat(publishedAt.get(0)).isEqualTo(publishedAt.get(1));
        } finally {
            pool.shutdownNow();
        }
        assertThat(issues(post)).isEqualTo(1);
    }

    @Test
    void post_unpublished_before_mail_goes_makes_mail_wait_and_go_when_post_is_republished() throws Exception {
        String email = address("go-bai");
        insertConfirmed(email);

        // Unpublished before the worker runs: the issue has not been split out yet.
        Post early = f.publishedPost("Post unpublished right after publishing");
        f.unpublish(early);
        worker.runOnce();
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT status FROM newsletter_issues WHERE post_id = ?", String.class, early.id()))
                .isEqualTo("PENDING");

        // Unpublished while the mail waits for a retry: the due attempt is postponed, not sent.
        transport.failure = message -> MailFailure.REJECTED;
        Post late = f.publishedPost("Post unpublished while mail is retried");
        worker.runOnce();
        assertThat(deliveryStatuses(late)).containsExactly("RETRYING");
        int attempts = transport.attempts.get();
        f.unpublish(late);
        clock.advance(Duration.ofHours(1));
        worker.runOnce();
        assertThat(transport.attempts).hasValue(attempts);

        transport.failure = message -> null;
        f.republish(early);
        f.republish(late);
        worker.runOnce();
        assertThat(transport.to(email, Kind.ISSUE))
                .extracting(MailMessage::subject)
                .containsExactlyInAnyOrder(
                        "Post unpublished right after publishing " + f.suffix,
                        "Post unpublished while mail is retried " + f.suffix);
        assertThat(issues(early) + issues(late)).isEqualTo(2);
    }

    // --- No duplicate sends, retries, provider down --------------------------------------------------------

    @Test
    void unique_key_and_splitting_the_issue_again_never_create_a_second_mail() throws Exception {
        String email = address("khong-trung");
        UUID subscriberId = insertConfirmed(email);
        Post post = f.publishedPost("Post not sent twice");
        worker.runOnce();
        assertThat(transport.to(email, Kind.ISSUE)).hasSize(1);

        assertThatThrownBy(() -> jdbcTemplate.update("""
                INSERT INTO newsletter_deliveries (post_id, subscriber_id, next_attempt_at)
                VALUES (?, ?, now())""", post.id(), subscriberId))
                .isInstanceOf(DataIntegrityViolationException.class);

        jdbcTemplate.update(
                "UPDATE newsletter_issues SET status = 'PENDING', expanded_at = NULL WHERE post_id = ?", post.id());
        clock.advance(Duration.ofMinutes(1));
        worker.runOnce();
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT status FROM newsletter_issues WHERE post_id = ?", String.class, post.id()))
                .isEqualTo("EXPANDED");
        assertThat(deliveryStatuses(post)).containsExactly("SENT");
        assertThat(transport.to(email, Kind.ISSUE)).hasSize(1);
    }

    @Test
    void unsubscribe_committing_during_issue_split_only_defers_that_issue_to_next_pass_without_stopping_the_pass()
            throws Exception {
        String leaving = address("roi-di");
        UUID leavingId = insertConfirmed(leaving);
        String staying = address("o-lai");
        insertConfirmed(staying);
        Post post = f.publishedPost("Post split off while someone unsubscribes");
        Logger logger = (Logger) LoggerFactory.getLogger(NewsletterWorker.class);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        logger.addAppender(logs);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try (HeldTransaction unsubscribe = new HeldTransaction(
                transactionManager,
                jdbcTemplate,
                jdbc -> jdbc.queryForList(
                        "SELECT id FROM newsletter_subscribers WHERE id = ? FOR UPDATE", leavingId))) {
            Future<NewsletterWorker.RunSummary> run = pool.submit(worker::runOnce);
            // The issue-splitting statement has reached the foreign key of the person who is unsubscribing and is
            // waiting on that lock.
            HeldTransaction.awaitWaitingOnLock(jdbcTemplate, "INSERT INTO newsletter_deliveries", 1);
            unsubscribe.commitAfter(jdbc -> jdbc.update("DELETE FROM newsletter_subscribers WHERE id = ?", leavingId));
            assertThat(run.get(30, TimeUnit.SECONDS).issuesExpanded()).isZero();
        } finally {
            pool.shutdownNow();
            logger.detachAppender(logs);
        }
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT status FROM newsletter_issues WHERE post_id = ?", String.class, post.id()))
                .isEqualTo("PENDING");
        assertThat(logs.list)
                .anySatisfy(event -> assertThat(event.getFormattedMessage())
                        .contains("rolled back", DataIntegrityViolationException.class.getName()));
        assertThat(logs.list)
                .allSatisfy(event -> assertThat(event.getFormattedMessage()).doesNotContain(leaving));

        worker.runOnce();
        assertThat(transport.to(staying, Kind.ISSUE)).hasSize(1);
        assertThat(transport.sent).noneMatch(mail -> mail.to().equals(leaving));
    }

    @Test
    void provider_down_does_not_block_publishing_error_is_recorded_as_safe_code_retried_on_schedule_then_DEAD()
            throws Exception {
        String email = address("sap");
        insertConfirmed(email);
        transport.failure = message -> MailFailure.CONNECTION_FAILED;

        Post post = f.publishedPost("Post published while the mail server is down");
        assertThat(transport.attempts).hasValue(0);

        worker.runOnce();
        for (int attempt = 1; attempt <= BACKOFF.size(); attempt++) {
            Map<String, Object> delivery = delivery(post);
            assertThat(delivery.get("status")).isEqualTo("RETRYING");
            assertThat(delivery.get("attempts")).isEqualTo(attempt);
            assertThat(delivery.get("last_error")).isEqualTo("CONNECTION_FAILED");
            assertThat(nextAttempt(post)).isEqualTo(clock.instant().plus(BACKOFF.get(attempt - 1)));
            // Not due yet: this pass does not try.
            worker.runOnce();
            assertThat(transport.attempts).hasValue(attempt);
            clock.advance(BACKOFF.get(attempt - 1));
            worker.runOnce();
        }
        Map<String, Object> dead = delivery(post);
        assertThat(dead.get("status")).isEqualTo("DEAD");
        assertThat(dead.get("attempts")).isEqualTo(BACKOFF.size() + 1);

        // The mail server comes back: a DEAD delivery is never sent again.
        transport.failure = message -> null;
        clock.advance(Duration.ofDays(2));
        worker.runOnce();
        assertThat(transport.sent).isEmpty();

        JsonNode stats = objectMapper
                .readTree(body(mockMvc.perform(get(STATS).header("Authorization", auth.bearerForAdmin()))
                        .andExpect(status().isOk())))
                .path("data");
        assertThat(stats.path("subscribers").path("pending").asLong()).isZero();
        assertThat(stats.path("subscribers").path("confirmed").asLong()).isEqualTo(1);
        assertThat(stats.path("suppressed").asLong()).isZero();
        assertThat(stats.path("issues")).singleElement().satisfies(issue -> {
            assertThat(issue.path("postId").asString()).isEqualTo(post.id().toString());
            assertThat(issue.path("slug").asString()).isEqualTo(post.slug());
            assertThat(issue.path("status").asString()).isEqualTo("EXPANDED");
            assertThat(List.of(
                            issue.path("sent").asLong(),
                            issue.path("retrying").asLong(),
                            issue.path("dead").asLong(),
                            issue.path("pending").asLong()))
                    .containsExactly(0L, 0L, 1L, 0L);
        });
        assertThat(stats.path("failures")).singleElement().satisfies(failure -> {
            assertThat(failure.path("reason").asString()).isEqualTo("CONNECTION_FAILED");
            assertThat(failure.path("count").asLong()).isEqualTo(1);
        });
        assertThat(stats.toString()).doesNotContain(email);
    }

    @Test
    void failed_confirmation_mail_rolls_back_and_next_pass_resends_one_addresss_failure_does_not_block_others()
            throws Exception {
        String first = address("xn-dau");
        String second = address("xn-hai");
        subscribe(first).andExpect(status().isAccepted());
        clock.advance(Duration.ofSeconds(1));
        subscribe(second).andExpect(status().isAccepted());

        // A failure of one address alone: that row rolls back (no hash, no send time), later people still receive the
        // mail.
        transport.failure = message -> message.to().equals(first) ? MailFailure.INVALID_ADDRESS : null;
        worker.runOnce();
        assertThat(column(first, "confirmation_token_hash")).isNull();
        assertThat(timestamp(first, "confirmation_sent_at")).isNull();
        assertThat(transport.to(second, Kind.CONFIRMATION)).hasSize(1);

        // A failure of the whole mail server: the step stops right at the first row, without trying each remaining
        // person.
        String third = address("xn-ba");
        clock.advance(Duration.ofSeconds(1));
        subscribe(third).andExpect(status().isAccepted());
        transport.failure = message -> MailFailure.CONNECTION_FAILED;
        int before = transport.attempts.get();
        worker.runOnce();
        assertThat(transport.attempts).hasValue(before + 1);

        transport.failure = message -> null;
        worker.runOnce();
        assertThat(transport.to(first, Kind.CONFIRMATION)).hasSize(1);
        assertThat(transport.to(third, Kind.CONFIRMATION)).hasSize(1);
        assertThat(column(first, "confirmation_token_hash"))
                .isEqualTo(NewsletterTokens.sha256Hex(confirmationToken(single(first, Kind.CONFIRMATION))));
    }

    // --- Retention period, address form, constraints ----------------------------------------------------

    @Test
    void unconfirmed_subscription_is_deleted_7_days_after_the_latest_request() throws Exception {
        String stale = address("cu");
        String renewed = address("gia-han");
        String confirmed = address("giu-lai");
        subscribe(stale).andExpect(status().isAccepted());
        subscribe(renewed).andExpect(status().isAccepted());
        insertConfirmed(confirmed);

        clock.advance(Duration.ofDays(6));
        subscribe(renewed).andExpect(status().isAccepted());
        clock.advance(Duration.ofDays(1).plusSeconds(1));
        worker.runOnce();

        assertThat(count("SELECT count(*) FROM newsletter_subscribers WHERE email = ?", stale))
                .isZero();
        assertThat(column(renewed, "status")).isEqualTo("PENDING");
        assertThat(column(confirmed, "status")).isEqualTo("CONFIRMED");
    }

    @Test
    void malformed_address_is_400_with_a_generic_message_does_not_echo_the_address_and_stores_nothing()
            throws Exception {
        for (String raw : List.of(
                "khong-phai-email",
                "ng" + (char) 0x01B0 + "oi@example.com",
                "ai@localhost",
                "x".repeat(250) + "@example.com",
                "")) {
            JsonNode error = f.assertError(subscribe(raw), 400, "VALIDATION_ERROR");
            assertThat(error.path("message").asString()).isEqualTo("Invalid email address");
        }
        f.assertError(
                mockMvc.perform(
                        post(SUBSCRIPTIONS).contentType(APPLICATION_JSON).content("{}")),
                400,
                "VALIDATION_ERROR");
        f.assertError(
                mockMvc.perform(
                        post(SUBSCRIPTIONS).contentType(APPLICATION_JSON).content("khong phai json")),
                400,
                "VALIDATION_ERROR");
        assertThat(count("SELECT count(*) FROM newsletter_subscribers")).isZero();
    }

    @Test
    void v31_constraints_block_wrong_status_raw_token_and_provider_error_message() throws Exception {
        UUID subscriberId = insertConfirmed(address("rang-buoc"));
        Post post = f.publishedPost("Post checking newsletter constraints");
        String raw = NewsletterTokens.newConfirmationToken();

        assertRejected("INSERT INTO newsletter_subscribers (email, status, confirmation_requested_at) "
                + "VALUES ('Hoa@example.com', 'PENDING', now())");
        assertRejected("INSERT INTO newsletter_subscribers (email, status, confirmation_requested_at) "
                + "VALUES ('a@example.com', 'ACTIVE', now())");
        assertRejected("INSERT INTO newsletter_subscribers (email, status) VALUES ('b@example.com', 'CONFIRMED')");
        assertRejected("INSERT INTO newsletter_subscribers (email, status) VALUES ('c@example.com', 'PENDING')");
        assertRejected("INSERT INTO newsletter_subscribers (email, status, confirmation_requested_at, "
                + "confirmation_sent_at, confirmation_token_hash, confirmation_expires_at) "
                + "VALUES ('d@example.com', 'PENDING', now(), now(), '" + raw + "', now())");
        assertRejected("INSERT INTO newsletter_subscribers (email, status, confirmation_requested_at, "
                + "confirmation_token_hash, confirmation_expires_at) "
                + "VALUES ('e@example.com', 'PENDING', now(), '" + "a".repeat(64) + "', now())");
        assertRejected("INSERT INTO newsletter_suppressions (email_hash) VALUES ('" + raw + "')");
        assertRejected(
                "INSERT INTO newsletter_deliveries (post_id, subscriber_id, status, next_attempt_at, last_error) "
                        + "VALUES ('" + post.id() + "', '" + subscriberId + "', 'RETRYING', now(), "
                        + "'550 rejected <rang-buoc@example.com>')");
        assertRejected("INSERT INTO newsletter_deliveries (post_id, subscriber_id, status, next_attempt_at) "
                + "VALUES ('" + post.id() + "', '" + subscriberId + "', 'DEAD', now())");
        assertRejected("INSERT INTO newsletter_deliveries (post_id, subscriber_id, status, next_attempt_at) "
                + "VALUES ('" + post.id() + "', '" + subscriberId + "', 'SENT', now())");
        assertRejected("INSERT INTO newsletter_deliveries (post_id, subscriber_id, next_attempt_at, attempts) "
                + "VALUES ('" + post.id() + "', '" + subscriberId + "', now(), -1)");
    }

    // --- Subscriber language (V9) -----------------------------------------------------------------------

    @Test
    void subscriber_locale_defaults_to_the_default_locale_is_refreshed_while_pending_and_kept_once_confirmed()
            throws Exception {
        String email = address("ngon-ngu");
        subscribe(email).andExpect(status().isAccepted());
        assertThat(column(email, "locale")).isEqualTo("vi");

        clock.advance(Duration.ofMinutes(1));
        subscribe(email, "en").andExpect(status().isAccepted());
        assertThat(column(email, "locale")).isEqualTo("en");
        clock.advance(Duration.ofMinutes(1));
        subscribe(email, "  VI ").andExpect(status().isAccepted());
        assertThat(column(email, "locale")).isEqualTo("vi");

        String confirmed = address("giu-ngon-ngu");
        insertConfirmed(confirmed, "en");
        subscribe(confirmed, "vi").andExpect(status().isAccepted());
        subscribe(confirmed).andExpect(status().isAccepted());
        assertThat(column(confirmed, "locale")).isEqualTo("en");
        assertThat(column(confirmed, "status")).isEqualTo("CONFIRMED");

        // A blank locale means the default one.
        String blank = address("ngon-ngu-trong");
        subscribe(blank, "").andExpect(status().isAccepted());
        assertThat(column(blank, "locale")).isEqualTo("vi");
    }

    @Test
    void locale_that_is_not_enabled_is_400_and_stores_nothing() throws Exception {
        String email = address("sai-ngon-ngu");
        for (String locale : List.of("fr", "english", "e n")) {
            JsonNode error = f.assertError(subscribe(email, locale), 400, "VALIDATION_ERROR");
            assertThat(error.path("message").asString()).doesNotContain(email);
        }
        assertThat(count("SELECT count(*) FROM newsletter_subscribers")).isZero();
    }

    @Test
    void confirmation_mail_follows_the_subscriber_locale_in_text_and_links_and_keeps_the_one_click_link_unprefixed()
            throws Exception {
        String english = address("xn-en");
        String vietnamese = address("xn-vi");
        subscribe(english, "en").andExpect(status().isAccepted());
        subscribe(vietnamese).andExpect(status().isAccepted());
        worker.runOnce();

        MailMessage en = single(english, Kind.CONFIRMATION);
        Pattern enLink = Pattern.compile(Pattern.quote(SITE + "/en/newsletter/confirm?token=") + "([A-Za-z0-9_-]+)");
        String enToken = group(enLink, en.body());
        String enUnsubscribe = oneClickToken(en);
        assertThat(en.subject()).isEqualTo(msg("en", "confirmation.subject"));
        assertThat(en.body())
                .isEqualTo(msg(
                        "en",
                        "confirmation.body",
                        SITE + "/en/newsletter/confirm?token=" + enToken,
                        SITE + "/en/newsletter/unsubscribe?token=" + enUnsubscribe));
        assertThat(en.listUnsubscribe()).isEqualTo(SITE + "/api/newsletter/unsubscribe?token=" + enUnsubscribe);

        MailMessage vi = single(vietnamese, Kind.CONFIRMATION);
        String viToken = confirmationToken(vi);
        String viUnsubscribe = oneClickToken(vi);
        assertThat(vi.subject()).isEqualTo(msg("vi", "confirmation.subject"));
        assertThat(vi.body())
                .isEqualTo(msg(
                        "vi",
                        "confirmation.body",
                        SITE + "/newsletter/confirm?token=" + viToken,
                        SITE + "/newsletter/unsubscribe?token=" + viUnsubscribe));
        assertThat(vi.body()).doesNotContain("/en/");
        assertThat(en.subject()).isNotEqualTo(vi.subject());

        // The confirm and unsubscribe calls do not depend on the language of the mail.
        confirm(enToken).andExpect(status().isOk());
        confirm(viToken).andExpect(status().isOk());
        unsubscribe(enUnsubscribe).andExpect(status().isOk());
        unsubscribe(viUnsubscribe).andExpect(status().isOk());
        assertThat(count("SELECT count(*) FROM newsletter_subscribers")).isZero();
    }

    @Test
    void issue_is_expanded_only_to_confirmed_subscribers_of_the_post_language_and_mail_text_and_links_follow_it()
            throws Exception {
        String reader = address("doc-en");
        String other = address("doc-vi");
        String pending = address("cho-en");
        insertConfirmed(reader, "en");
        insertConfirmed(other, "vi");
        subscribe(pending, "en").andExpect(status().isAccepted());

        Post post = f.publishedPost("English post for the newsletter");
        setLanguage(post, "en");
        worker.runOnce();

        assertThat(deliveryStatuses(post)).containsExactly("SENT");
        assertThat(transport.to(other, Kind.ISSUE)).isEmpty();
        assertThat(transport.to(pending, Kind.ISSUE)).isEmpty();
        MailMessage mail = single(reader, Kind.ISSUE);
        String unsubscribeToken = oneClickToken(mail);
        String title = "English post for the newsletter " + f.suffix;
        assertThat(mail.subject()).isEqualTo(title);
        assertThat(mail.body())
                .isEqualTo(title
                        + "\n\nSummary " + f.suffix
                        + "\n\n" + msg("en", "issue.read", SITE + "/en/posts/" + post.slug())
                        + "\n\n--\n" + msg("en", "issue.reason")
                        + "\n"
                        + msg("en", "issue.unsubscribe", SITE + "/en/newsletter/unsubscribe?token=" + unsubscribeToken)
                        + "\n");
        assertThat(mail.listUnsubscribe()).isEqualTo(SITE + "/api/newsletter/unsubscribe?token=" + unsubscribeToken);
    }

    @Test
    void default_language_issue_goes_only_to_its_subscribers_with_unprefixed_links_and_the_default_language_text()
            throws Exception {
        String reader = address("doc-vi-2");
        String other = address("doc-en-2");
        insertConfirmed(reader, "vi");
        insertConfirmed(other, "en");

        Post post = f.publishedPost("Default language post for the newsletter");
        worker.runOnce();

        assertThat(transport.to(other, Kind.ISSUE)).isEmpty();
        MailMessage mail = single(reader, Kind.ISSUE);
        String unsubscribeToken = oneClickToken(mail);
        assertThat(mail.body())
                .contains(
                        msg("vi", "issue.read", SITE + "/posts/" + post.slug()),
                        msg("vi", "issue.reason"),
                        msg("vi", "issue.unsubscribe", SITE + "/newsletter/unsubscribe?token=" + unsubscribeToken))
                .doesNotContain("/en/");
        assertThat(msg("vi", "issue.reason")).isNotEqualTo(msg("en", "issue.reason"));
    }

    @Test
    void
            issue_without_a_matching_subscriber_has_no_deliveries_is_still_expanded_and_repeating_the_expansion_adds_nothing()
                    throws Exception {
        String vietnamese = address("chi-vi");
        insertConfirmed(vietnamese, "vi");
        Post post = f.publishedPost("English post nobody reads");
        setLanguage(post, "en");
        worker.runOnce();
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT status FROM newsletter_issues WHERE post_id = ?", String.class, post.id()))
                .isEqualTo("EXPANDED");
        assertThat(deliveryStatuses(post)).isEmpty();

        // A matching subscriber appears and the expansion runs twice: one delivery, one mail.
        String english = address("moi-en");
        insertConfirmed(english, "en");
        for (int i = 0; i < 2; i++) {
            jdbcTemplate.update(
                    "UPDATE newsletter_issues SET status = 'PENDING', expanded_at = NULL WHERE post_id = ?", post.id());
            worker.runOnce();
            assertThat(deliveryStatuses(post)).containsExactly("SENT");
        }
        assertThat(transport.to(english, Kind.ISSUE)).hasSize(1);
        assertThat(transport.to(vietnamese, Kind.ISSUE)).isEmpty();
    }

    // --- The newsletter of an AUTHOR's post waits for an administrator (V48) ---------------------------------

    private static final String NEWSLETTER = "/api/v1/admin/newsletter";

    @Test
    void an_authors_first_publish_is_held_and_nothing_is_mailed_until_an_admin_releases_that_one_issue()
            throws Exception {
        String subscriber = address("giu-lai");
        insertConfirmed(subscriber);
        String author = f.author("giu-lai").bearer();
        Post first = f.publishedPostBy(author, "Held post one");
        Post second = f.publishedPostBy(author, "Held post two");
        Post third = f.publishedPostBy(author, "Held post three");

        assertThat(List.of(issueStatus(first), issueStatus(second), issueStatus(third)))
                .containsOnly("HELD");
        worker.runOnce();
        worker.runOnce();
        assertThat(count("SELECT count(*) FROM newsletter_deliveries")).isZero();
        assertThat(transport.to(subscriber, Kind.ISSUE)).isEmpty();

        release(auth.bearerForAdmin(), second).andExpect(status().isNoContent());
        assertThat(issueStatus(second)).isEqualTo("PENDING");
        worker.runOnce();

        assertThat(deliveryStatuses(second)).containsExactly("SENT");
        assertThat(deliveryStatuses(first)).isEmpty();
        assertThat(deliveryStatuses(third)).isEmpty();
        assertThat(transport.to(subscriber, Kind.ISSUE)).hasSize(1);
        assertThat(issueStatus(first)).isEqualTo("HELD");
        assertThat(issueStatus(third)).isEqualTo("HELD");
    }

    @Test
    void
            an_admin_publishing_queues_the_issue_even_for_a_post_an_author_wrote_and_a_later_admin_publish_releases_nothing()
                    throws Exception {
        Post byAdmin = f.publishedPost("Published by the admin");
        assertThat(issueStatus(byAdmin)).isEqualTo("PENDING");

        String author = f.author("viet-bai").bearer();
        Post draft = authorDraft(author, "Written by an author");
        mockMvc.perform(post("/api/v1/admin/posts/" + draft.id() + "/publish")
                        .header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk());
        assertThat(issueStatus(draft)).isEqualTo("PENDING");

        Post held = f.publishedPostBy(author, "Held until released");
        assertThat(issueStatus(held)).isEqualTo("HELD");
        f.unpublish(held);
        f.republish(held);
        assertThat(issueStatus(held))
                .as("an ADMIN republishing does not release it")
                .isEqualTo("HELD");
    }

    @Test
    void only_an_admin_lists_releases_or_discards_and_a_decision_is_made_once() throws Exception {
        String author = f.author("quyen").bearer();
        Post held = f.publishedPostBy(author, "Held for the permission checks");
        Post queued = f.publishedPost("Queued by the admin");
        String admin = auth.bearerForAdmin();

        mockMvc.perform(get(NEWSLETTER + "/held").header("Authorization", author))
                .andExpect(status().isForbidden());
        release(author, held).andExpect(status().isForbidden());
        decide(author, held, "discard").andExpect(status().isForbidden());
        mockMvc.perform(get(NEWSLETTER + "/held")).andExpect(status().isUnauthorized());
        assertThat(issueStatus(held)).isEqualTo("HELD");

        f.assertError(release(admin, queued), 404, "NEWSLETTER_ISSUE_NOT_FOUND");
        f.assertError(
                mockMvc.perform(post(NEWSLETTER + "/issues/" + UUID.randomUUID() + "/discard")
                        .header("Authorization", admin)),
                404,
                "NEWSLETTER_ISSUE_NOT_FOUND");

        release(admin, held).andExpect(status().isNoContent());
        f.assertError(release(admin, held), 404, "NEWSLETTER_ISSUE_NOT_FOUND");
        f.assertError(decide(admin, held, "discard"), 404, "NEWSLETTER_ISSUE_NOT_FOUND");
        assertThat(issueStatus(held)).isEqualTo("PENDING");
    }

    @Test
    void a_discarded_issue_is_kept_as_a_record_and_never_mailed() throws Exception {
        String subscriber = address("tu-choi");
        insertConfirmed(subscriber);
        Post held = f.publishedPostBy(f.author("tu-choi").bearer(), "Held then refused");
        UUID admin = adminId();

        decide(auth.bearerForAdmin(), held, "discard").andExpect(status().isNoContent());
        worker.runOnce();

        assertThat(issueStatus(held)).isEqualTo("DISCARDED");
        assertThat(jdbcTemplate.queryForObject(
                        "SELECT decided_by FROM newsletter_issues WHERE post_id = ?", UUID.class, held.id()))
                .isEqualTo(admin);
        assertThat(deliveryStatuses(held)).isEmpty();
        assertThat(transport.to(subscriber, Kind.ISSUE)).isEmpty();
        f.assertError(release(auth.bearerForAdmin(), held), 404, "NEWSLETTER_ISSUE_NOT_FOUND");
        // Re-publishing the post does not bring a second issue.
        f.unpublish(held);
        f.republish(held);
        worker.runOnce();
        assertThat(issueStatus(held)).isEqualTo("DISCARDED");
        assertThat(transport.to(subscriber, Kind.ISSUE)).isEmpty();
    }

    @Test
    void the_held_list_shows_what_would_be_mailed_the_author_and_how_many_would_get_it() throws Exception {
        insertConfirmed(address("nguoi-1"));
        insertConfirmed(address("nguoi-2"));
        insertConfirmed(address("nguoi-en"), "en");
        jdbcTemplate.update(
                "INSERT INTO newsletter_subscribers (email, status, confirmation_requested_at, locale) "
                        + "VALUES (?, 'PENDING', now(), 'vi')",
                address("chua-xac-nhan"));
        Reader author = f.author("danh-sach");
        Post held = f.publishedPostBy(author.bearer(), "Held and listed");
        jdbcTemplate.update("UPDATE posts SET excerpt = repeat('x', 900) WHERE id = ?", held.id());

        JsonNode list = f.data(mockMvc.perform(get(NEWSLETTER + "/held").header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk()));

        assertThat(list).hasSize(1);
        JsonNode item = list.get(0);
        assertThat(item.path("postId").asString()).isEqualTo(held.id().toString());
        assertThat(item.path("slug").asString()).isEqualTo(held.slug());
        assertThat(item.path("title").asString()).isEqualTo("Held and listed " + f.suffix);
        assertThat(item.path("authorName").asString()).isEqualTo(author.displayName());
        assertThat(item.path("language").asString()).isEqualTo("vi");
        assertThat(item.path("published").asBoolean()).isTrue();
        assertThat(item.path("recipients").asLong())
                .as("confirmed subscribers of the post language")
                .isEqualTo(2);
        assertThat(item.path("excerpt")
                        .asString()
                        .codePointCount(0, item.path("excerpt").asString().length()))
                .isEqualTo(300);
        assertThat(body(mockMvc.perform(get(NEWSLETTER + "/held").header("Authorization", auth.bearerForAdmin()))))
                .doesNotContain("@");

        release(auth.bearerForAdmin(), held).andExpect(status().isNoContent());
        assertThat(f.data(mockMvc.perform(get(NEWSLETTER + "/held").header("Authorization", auth.bearerForAdmin()))))
                .isEmpty();
    }

    @Test
    void what_the_admin_released_is_what_is_mailed_even_if_the_author_edits_the_post_afterwards() throws Exception {
        String subscriber = address("da-duyet");
        insertConfirmed(subscriber);
        String authorBearer = f.author("da-duyet").bearer();
        Post held = f.publishedPostBy(authorBearer, "Approved title");
        String approvedTitle = "Approved title " + f.suffix;

        release(auth.bearerForAdmin(), held).andExpect(status().isNoContent());
        authorEdits(authorBearer, held, "Buy cheap pills now", "Spam excerpt after the approval", null)
                .andExpect(status().isOk());
        worker.runOnce();

        MailMessage mail = single(subscriber, Kind.ISSUE);
        assertThat(mail.subject()).isEqualTo(approvedTitle);
        assertThat(mail.body()).contains(approvedTitle, "Summary " + f.suffix).doesNotContain("pills", "Spam");
    }

    @Test
    void a_release_is_refused_when_the_author_changed_the_text_after_the_admin_loaded_the_list() throws Exception {
        String subscriber = address("doi-van-ban");
        insertConfirmed(subscriber);
        String authorBearer = f.author("doi-van-ban").bearer();
        String admin = auth.bearerForAdmin();
        Post held = f.publishedPostBy(authorBearer, "Title the admin saw");
        String seen = reviewedVersion(held);

        authorEdits(authorBearer, held, "Buy cheap pills now", "Spam excerpt after the page loaded", null)
                .andExpect(status().isOk());

        f.assertError(releaseWith(admin, held, seen), 409, "NEWSLETTER_ISSUE_CHANGED");
        assertThat(issueStatus(held)).as("a refused release changes nothing").isEqualTo("HELD");
        assertThat(count(
                        "SELECT count(*) FROM newsletter_issues WHERE post_id = ? AND approved_title IS NOT NULL",
                        held.id()))
                .isZero();
        worker.runOnce();
        assertThat(count("SELECT count(*) FROM newsletter_deliveries")).isZero();
        assertThat(transport.to(subscriber, Kind.ISSUE)).isEmpty();

        String current = reviewedVersion(held);
        assertThat(current).as("the list shows the new text with a new version").isNotEqualTo(seen);
        releaseWith(admin, held, current).andExpect(status().isNoContent());
        worker.runOnce();
        assertThat(single(subscriber, Kind.ISSUE).subject()).isEqualTo("Buy cheap pills now");
    }

    @Test
    void a_release_checks_the_excerpt_the_language_and_the_address_the_admin_saw_not_only_the_title() throws Exception {
        String authorBearer = f.author("kiem-tra-het").bearer();
        String admin = auth.bearerForAdmin();
        Post held = f.publishedPostBy(authorBearer, "Every part of the text");
        String original = reviewedVersion(held);
        String title = "Every part of the text " + f.suffix;

        authorEdits(authorBearer, held, title, "Another excerpt", null).andExpect(status().isOk());
        f.assertError(releaseWith(admin, held, original), 409, "NEWSLETTER_ISSUE_CHANGED");

        authorEdits(authorBearer, held, title, "Summary " + f.suffix, "en").andExpect(status().isOk());
        assertThat(reviewedVersion(held))
                .as("another language is another audience")
                .isNotEqualTo(original);
        f.assertError(releaseWith(admin, held, original), 409, "NEWSLETTER_ISSUE_CHANGED");

        authorEdits(authorBearer, held, title, "Summary " + f.suffix, "vi").andExpect(status().isOk());
        jdbcTemplate.update("UPDATE posts SET slug = slug || '-moved' WHERE id = ?", held.id());
        f.assertError(releaseWith(admin, held, original), 409, "NEWSLETTER_ISSUE_CHANGED");
        assertThat(issueStatus(held)).isEqualTo("HELD");
    }

    @Test
    void a_text_changed_and_changed_back_is_the_text_the_admin_saw_and_can_be_released() throws Exception {
        String authorBearer = f.author("doi-lai").bearer();
        Post held = f.publishedPostBy(authorBearer, "Back and forth");
        String seen = reviewedVersion(held);
        String title = "Back and forth " + f.suffix;

        authorEdits(authorBearer, held, "Something else", "Summary " + f.suffix, null)
                .andExpect(status().isOk());
        f.assertError(releaseWith(auth.bearerForAdmin(), held, seen), 409, "NEWSLETTER_ISSUE_CHANGED");
        authorEdits(authorBearer, held, title, "Summary " + f.suffix, null).andExpect(status().isOk());

        releaseWith(auth.bearerForAdmin(), held, seen).andExpect(status().isNoContent());
        assertThat(issueStatus(held)).isEqualTo("PENDING");
    }

    @Test
    void a_release_needs_the_version_the_admin_saw() throws Exception {
        Post held = f.publishedPostBy(f.author("thieu-ban").bearer(), "No version sent");
        String admin = auth.bearerForAdmin();
        String url = NEWSLETTER + "/issues/" + held.id() + "/release";

        f.assertError(mockMvc.perform(post(url).header("Authorization", admin)), 400, "VALIDATION_ERROR");
        f.assertError(
                mockMvc.perform(post(url)
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content("{}")),
                400,
                "VALIDATION_ERROR");
        f.assertError(
                mockMvc.perform(post(url)
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(f.json(Map.of("version", "x".repeat(500))))),
                400,
                "VALIDATION_ERROR");
        f.assertError(releaseWith(admin, held, "not-the-version"), 409, "NEWSLETTER_ISSUE_CHANGED");
        assertThat(issueStatus(held)).isEqualTo("HELD");
    }

    @Test
    void the_language_the_admin_approved_decides_who_gets_the_mail_even_if_the_post_language_changes_later()
            throws Exception {
        String vietnamese = address("tieng-viet");
        String english = address("tieng-anh");
        insertConfirmed(vietnamese, "vi");
        insertConfirmed(english, "en");
        String authorBearer = f.author("doi-ngon-ngu").bearer();
        Post held = f.publishedPostBy(authorBearer, "Approved in Vietnamese");
        // Taken down first, so that the worker does not mail it before the author changes the language.
        f.unpublish(held);
        release(auth.bearerForAdmin(), held).andExpect(status().isNoContent());

        authorEdits(authorBearer, held, "Approved in Vietnamese " + f.suffix, "Summary " + f.suffix, "en")
                .andExpect(status().isOk());
        f.republish(held);
        worker.runOnce();

        assertThat(transport.to(vietnamese, Kind.ISSUE)).hasSize(1);
        assertThat(transport.to(english, Kind.ISSUE)).isEmpty();
    }

    @Test
    void a_held_issue_of_an_unpublished_post_waits_after_release_until_the_post_is_published_again() throws Exception {
        String subscriber = address("cho-dang-lai");
        insertConfirmed(subscriber);
        Post held = f.publishedPostBy(f.author("cho-dang-lai").bearer(), "Held then unpublished");
        f.unpublish(held);

        release(auth.bearerForAdmin(), held).andExpect(status().isNoContent());
        worker.runOnce();
        assertThat(transport.to(subscriber, Kind.ISSUE)).isEmpty();

        f.republish(held);
        worker.runOnce();
        assertThat(transport.to(subscriber, Kind.ISSUE)).hasSize(1);
    }

    @Test
    void v45_constraints_keep_a_held_issue_undecided_and_a_discarded_one_decided() throws Exception {
        Post draft = f.draftPost("Draft for the issue constraints");
        String id = "'" + draft.id() + "'";

        assertRejected("INSERT INTO newsletter_issues (post_id, status) VALUES (" + id + ", 'REFUSED')");
        assertRejected(
                "INSERT INTO newsletter_issues (post_id, status, decided_at) VALUES (" + id + ", 'HELD', now())");
        assertRejected("INSERT INTO newsletter_issues (post_id, status) VALUES (" + id + ", 'DISCARDED')");
        assertRejected("INSERT INTO newsletter_issues (post_id, status, approved_title) VALUES (" + id
                + ", 'PENDING', 'approved but never decided')");
        assertThat(jdbcTemplate.update("INSERT INTO newsletter_issues (post_id, status) VALUES (" + id + ", 'HELD')"))
                .isEqualTo(1);
    }

    @Test
    void v48_keeps_an_approved_language_that_exists_and_comes_with_an_approved_title() throws Exception {
        Post draft = f.draftPost("Draft for the language constraint");
        String id = "'" + draft.id() + "'";
        String decided = "status, decided_at";

        assertRejected("INSERT INTO newsletter_issues (post_id, " + decided
                + ", approved_title, approved_language) VALUES (" + id + ", 'PENDING', now(), 'approved', 'fr')");
        assertRejected("INSERT INTO newsletter_issues (post_id, " + decided + ", approved_language) VALUES (" + id
                + ", 'PENDING', now(), 'vi')");
        assertThat(jdbcTemplate.update("INSERT INTO newsletter_issues (post_id, " + decided
                        + ", approved_title, approved_language) VALUES (" + id
                        + ", 'PENDING', now(), 'approved', 'vi')"))
                .isEqualTo(1);
    }

    // --- Helpers ----------------------------------------------------------------------------------------

    private String issueStatus(Post post) {
        return jdbcTemplate.queryForObject(
                "SELECT status FROM newsletter_issues WHERE post_id = ?", String.class, post.id());
    }

    /** What the held list shows for this post now: the version the admin screen sends back with a release. */
    private String reviewedVersion(Post post) throws Exception {
        JsonNode list = f.data(mockMvc.perform(get(NEWSLETTER + "/held").header("Authorization", auth.bearerForAdmin()))
                .andExpect(status().isOk()));
        for (JsonNode item : list) {
            if (item.path("postId").asString().equals(post.id().toString())) {
                return item.path("version").asString();
            }
        }
        return "0".repeat(64);
    }

    /** A release of what the list shows right now. */
    private ResultActions release(String bearer, Post post) throws Exception {
        return releaseWith(bearer, post, reviewedVersion(post));
    }

    private ResultActions releaseWith(String bearer, Post post, String version) throws Exception {
        return mockMvc.perform(post(NEWSLETTER + "/issues/" + post.id() + "/release")
                .header("Authorization", bearer)
                .contentType(APPLICATION_JSON)
                .content(f.json(Map.of("version", version))));
    }

    /** The author saves the post again with this text; a null language keeps the language. */
    private ResultActions authorEdits(String authorBearer, Post post, String title, String excerpt, String language)
            throws Exception {
        JsonNode current =
                f.data(mockMvc.perform(get("/api/v1/admin/posts/" + post.id()).header("Authorization", authorBearer))
                        .andExpect(status().isOk()));
        Map<String, Object> body = new HashMap<>();
        body.put("title", title);
        body.put("excerpt", excerpt);
        body.put("content", current.path("content").asString());
        body.put("categoryId", current.path("category").path("id").asString());
        if (language != null) {
            body.put("language", language);
        }
        return mockMvc.perform(put("/api/v1/admin/posts/" + post.id())
                .header("Authorization", authorBearer)
                .contentType(APPLICATION_JSON)
                .content(f.json(body)));
    }

    private ResultActions decide(String bearer, Post post, String verb) throws Exception {
        return mockMvc.perform(
                post(NEWSLETTER + "/issues/" + post.id() + "/" + verb).header("Authorization", bearer));
    }

    private UUID adminId() {
        return jdbcTemplate.queryForObject("SELECT id FROM users WHERE email = 'admin@blog.local'", UUID.class);
    }

    /** A draft written by an AUTHOR (the fixtures only publish): the category is one that already exists. */
    private Post authorDraft(String bearer, String title) throws Exception {
        UUID category = jdbcTemplate.queryForObject("SELECT id FROM categories LIMIT 1", UUID.class);
        if (category == null) {
            throw new IllegalStateException("no category");
        }
        JsonNode created = f.data(mockMvc.perform(post("/api/v1/admin/posts")
                        .header("Authorization", bearer)
                        .contentType(APPLICATION_JSON)
                        .content(f.json(Map.of(
                                "title", title + " " + f.suffix,
                                "excerpt", "Summary " + f.suffix,
                                "content", "Draft content " + f.suffix,
                                "categoryId", category.toString()))))
                .andExpect(status().isCreated()));
        return new Post(
                UUID.fromString(created.path("id").asString()),
                created.path("slug").asString());
    }

    private String address(String stem) {
        return "nl-" + stem + "-" + f.suffix + "@example.com";
    }

    private ResultActions subscribe(String email) throws Exception {
        return mockMvc.perform(
                post(SUBSCRIPTIONS).contentType(APPLICATION_JSON).content(f.json(Map.of("email", email))));
    }

    private ResultActions subscribe(String email, String locale) throws Exception {
        return mockMvc.perform(post(SUBSCRIPTIONS)
                .contentType(APPLICATION_JSON)
                .content(f.json(Map.of("email", email, "locale", locale))));
    }

    /** The text of the real bundle, so the tests hold no translated literal. */
    private static String msg(String language, String key, Object... args) {
        ResourceBundleMessageSource bundle = new ResourceBundleMessageSource();
        bundle.setBasename("i18n/newsletter");
        bundle.setDefaultEncoding("UTF-8");
        bundle.setDefaultLocale(Locale.ENGLISH);
        return bundle.getMessage(key, args, Locale.forLanguageTag(language));
    }

    private void setLanguage(Post post, String language) {
        jdbcTemplate.update("UPDATE posts SET language = ? WHERE id = ?", language, post.id());
    }

    private ResultActions confirm(String token) throws Exception {
        return mockMvc.perform(post(CONFIRM).contentType(APPLICATION_JSON).content(f.json(Map.of("token", token))));
    }

    private ResultActions unsubscribe(String token) throws Exception {
        return mockMvc.perform(post(UNSUBSCRIBE).contentType(APPLICATION_JSON).content(f.json(Map.of("token", token))));
    }

    private static String body(ResultActions result) throws Exception {
        return result.andReturn().getResponse().getContentAsString();
    }

    private MailMessage single(String email, Kind kind) {
        List<MailMessage> mails = transport.to(email, kind);
        assertThat(mails).as("%s mails", kind).hasSize(1);
        return mails.getFirst();
    }

    private static String confirmationToken(MailMessage mail) {
        return group(CONFIRM_LINK, mail.body());
    }

    private static String oneClickToken(MailMessage mail) {
        return group(ONE_CLICK, mail.listUnsubscribe());
    }

    private static String group(Pattern pattern, String text) {
        Matcher matcher = pattern.matcher(text);
        assertThat(matcher.find()).as("link in %s", pattern).isTrue();
        return matcher.group(1);
    }

    private UUID insertConfirmed(String email) {
        return insertConfirmed(email, "vi");
    }

    private UUID insertConfirmed(String email, String locale) {
        UUID id = UUID.randomUUID();
        OffsetDateTime now = OffsetDateTime.ofInstant(clock.instant(), ZoneOffset.UTC);
        jdbcTemplate.update("""
                INSERT INTO newsletter_subscribers (id, email, status, created_at, confirmed_at, locale)
                VALUES (?, ?, 'CONFIRMED', ?, ?, ?)""", id, email, now, now, locale);
        return id;
    }

    private UUID subscriberId(String email) {
        return jdbcTemplate.queryForObject("SELECT id FROM newsletter_subscribers WHERE email = ?", UUID.class, email);
    }

    private String column(String email, String column) {
        return jdbcTemplate.queryForObject(
                "SELECT " + column + " FROM newsletter_subscribers WHERE email = ?", String.class, email);
    }

    private Instant timestamp(String email, String column) {
        OffsetDateTime value = jdbcTemplate.queryForObject(
                "SELECT " + column + " FROM newsletter_subscribers WHERE email = ?", OffsetDateTime.class, email);
        return value == null ? null : value.toInstant();
    }

    private long count(String sql, Object... args) {
        return jdbcTemplate.queryForObject(sql, Long.class, args);
    }

    private long issues(Post post) {
        return count("SELECT count(*) FROM newsletter_issues WHERE post_id = ?", post.id());
    }

    private List<String> deliveryStatuses(Post post) {
        return jdbcTemplate.queryForList(
                "SELECT status FROM newsletter_deliveries WHERE post_id = ?", String.class, post.id());
    }

    private Map<String, Object> delivery(Post post) {
        return jdbcTemplate.queryForMap(
                "SELECT status, attempts, last_error FROM newsletter_deliveries WHERE post_id = ?", post.id());
    }

    private Instant nextAttempt(Post post) {
        return jdbcTemplate
                .queryForObject(
                        "SELECT next_attempt_at FROM newsletter_deliveries WHERE post_id = ?",
                        OffsetDateTime.class,
                        post.id())
                .toInstant();
    }

    private static Map<String, List<String>> headers(MockHttpServletResponse response) {
        Map<String, List<String>> headers = new LinkedHashMap<>();
        for (String name : response.getHeaderNames()) {
            headers.put(name, response.getHeaders(name));
        }
        return headers;
    }

    /** Edits the content of a post through the admin's full PUT, keeping the title, summary and category. */
    private void edit(Post post, String content) throws Exception {
        String admin = auth.bearerForAdmin();
        JsonNode current = objectMapper
                .readTree(body(
                        mockMvc.perform(get("/api/v1/admin/posts/" + post.id()).header("Authorization", admin))
                                .andExpect(status().isOk())))
                .path("data");
        mockMvc.perform(put("/api/v1/admin/posts/" + post.id())
                        .header("Authorization", admin)
                        .contentType(APPLICATION_JSON)
                        .content(f.json(Map.of(
                                "title",
                                current.path("title").asString(),
                                "excerpt",
                                current.path("excerpt").asString(),
                                "content",
                                content,
                                "categoryId",
                                current.path("category").path("id").asString()))))
                .andExpect(status().isOk());
    }

    private void assertRejected(String sql) {
        assertThatThrownBy(() -> jdbcTemplate.update(sql)).as(sql).isInstanceOf(DataIntegrityViolationException.class);
    }
}
