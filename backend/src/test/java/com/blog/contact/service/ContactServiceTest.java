package com.blog.contact.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.I18nProperties;
import com.blog.common.i18n.Languages;
import com.blog.common.ratelimit.ClientAddress;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.contact.config.ContactProperties;
import com.blog.contact.dto.ContactMessageRequest;
import com.blog.contact.repository.ContactMessageRepository;
import com.blog.newsletter.mail.MailFailure;
import com.blog.newsletter.mail.MailMessage;
import com.blog.newsletter.mail.MailMessage.Kind;
import com.blog.newsletter.mail.MailTransport;
import com.blog.newsletter.mail.MailTransportException;
import com.blog.support.LogAssertions;
import com.blog.support.RateLimitTestProperties;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;

/**
 * The contact form rules without a database: what is cleaned and checked, what is stored, when a mail is sent, and that
 * a failing mail never loses the row. The per-address count itself is a SQL statement, proved in ContactIT.
 */
class ContactServiceTest {

    private static final Instant NOW = Instant.parse("2026-03-04T10:15:30Z");
    private static final String RECIPIENT = "owner@example.com";
    private static final String NAME = "Visitor Name";
    private static final String EMAIL = "visitor.secret@example.com";
    private static final String TEXT = "A message long enough to be accepted.";
    private static final ClientAddress CLIENT =
            ClientAddress.parse("203.0.113.9").orElseThrow();
    // Control characters built from code points, so the source file holds none of them.
    private static final String NUL = String.valueOf((char) 0x00);
    private static final String BEL = String.valueOf((char) 0x07);
    private static final String DEL = String.valueOf((char) 0x7f);
    private static final String NEL = String.valueOf((char) 0x85);
    private static final String LINE_SEPARATOR = String.valueOf((char) 0x2028);

    private final ContactMessageRepository repository = mock(ContactMessageRepository.class);
    private final List<MailMessage> sent = new ArrayList<>();
    private MailTransport transport = sent::add;
    private final Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);
    private final Languages languages = new Languages(new I18nProperties(List.of("vi", "en"), "vi"));
    /** The real limiter with the real defaults; a test that needs another limit builds its own. */
    private RateLimiter limiter = new RateLimiter(RateLimitTestProperties.defaults());

    private final Logger root = (Logger) LoggerFactory.getLogger(Logger.ROOT_LOGGER_NAME);
    private final ListAppender<ILoggingEvent> logs = new ListAppender<>();

    @BeforeEach
    void captureLogsAndAcceptInserts() {
        logs.start();
        root.addAppender(logs);
        when(repository.insertUnlessLimited(any(), any(), any(), any(), any(), any(), any(), any(), anyInt()))
                .thenReturn(true);
    }

    @AfterEach
    void releaseLogs() {
        root.detachAppender(logs);
    }

    /** What the service handed to the repository. */
    private record Stored(
            UUID id,
            String name,
            String email,
            String subject,
            String message,
            String locale,
            Instant now,
            Instant windowStart,
            int max) {}

    private ContactService service(String recipient) {
        return new ContactService(
                repository,
                message -> transport.send(message),
                languages,
                limiter,
                clock,
                new ContactProperties(recipient));
    }

    private static ContactMessageRequest request(
            String name, String email, String subject, String message, String locale) {
        return new ContactMessageRequest(name, email, subject, message, locale);
    }

    private static ContactMessageRequest valid() {
        return request(NAME, EMAIL, "Hello", TEXT, "en");
    }

    private Stored stored() {
        ArgumentCaptor<UUID> id = ArgumentCaptor.forClass(UUID.class);
        ArgumentCaptor<String> name = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> email = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> subject = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> message = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> locale = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<Instant> now = ArgumentCaptor.forClass(Instant.class);
        ArgumentCaptor<Instant> windowStart = ArgumentCaptor.forClass(Instant.class);
        ArgumentCaptor<Integer> max = ArgumentCaptor.forClass(Integer.class);
        verify(repository)
                .insertUnlessLimited(
                        id.capture(),
                        name.capture(),
                        email.capture(),
                        subject.capture(),
                        message.capture(),
                        locale.capture(),
                        now.capture(),
                        windowStart.capture(),
                        max.capture());
        return new Stored(
                id.getValue(),
                name.getValue(),
                email.getValue(),
                subject.getValue(),
                message.getValue(),
                locale.getValue(),
                now.getValue(),
                windowStart.getValue(),
                max.getValue());
    }

    @Test
    void stores_the_cleaned_fields_with_the_window_of_one_hour_and_five_messages() {
        service("")
                .submit(
                        request(" Visitor Name ", "  Visitor.Secret@Example.COM ", " Hello ", "  " + TEXT + "  ", "en"),
                        CLIENT);

        Stored stored = stored();
        assertThat(stored.name()).isEqualTo(NAME);
        assertThat(stored.email()).isEqualTo(EMAIL);
        assertThat(stored.subject()).isEqualTo("Hello");
        assertThat(stored.message()).isEqualTo(TEXT);
        assertThat(stored.locale()).isEqualTo("en");
        assertThat(stored.now()).isEqualTo(NOW);
        assertThat(stored.windowStart()).isEqualTo(NOW.minus(Duration.ofHours(1)));
        assertThat(stored.max()).isEqualTo(5);
    }

    @Test
    void control_characters_are_removed_from_name_and_subject_but_the_message_keeps_its_newlines() {
        service("")
                .submit(
                        request(
                                "Vis\r\nitor\tName" + NUL + LINE_SEPARATOR,
                                EMAIL,
                                "Hel\r\nBcc: attacker@example.com;\nlo" + DEL + NEL,
                                "first line\r\nsecond line\rthird" + NUL + " line\ttabbed" + BEL,
                                null),
                        CLIENT);

        Stored stored = stored();
        assertThat(stored.name()).isEqualTo("VisitorName");
        assertThat(stored.subject()).isEqualTo("HelBcc: attacker@example.com;lo");
        assertThat(stored.message()).isEqualTo("first line\nsecond line\nthird line\ttabbed");
        assertThat(stored.locale()).isNull();
    }

    @Test
    void a_missing_blank_or_control_only_subject_is_stored_as_null() {
        for (String subject : new String[] {null, "", "   ", "\r\n\t"}) {
            ContactMessageRepository fresh = mock(ContactMessageRepository.class);
            when(fresh.insertUnlessLimited(any(), any(), any(), any(), any(), any(), any(), any(), anyInt()))
                    .thenReturn(true);
            new ContactService(fresh, sent::add, languages, limiter, clock, new ContactProperties(""))
                    .submit(request(NAME, EMAIL, subject, TEXT, null), CLIENT);
            ArgumentCaptor<String> stored = ArgumentCaptor.forClass(String.class);
            verify(fresh)
                    .insertUnlessLimited(any(), any(), any(), stored.capture(), any(), any(), any(), any(), anyInt());
            assertThat(stored.getValue()).isNull();
        }
    }

    @Test
    void every_bad_field_is_one_generic_400_and_nothing_is_stored_or_mailed() {
        ContactService service = service(RECIPIENT);
        List<ContactMessageRequest> bad = List.of(
                request(null, EMAIL, null, TEXT, null),
                request("   ", EMAIL, null, TEXT, null),
                request("\r\n", EMAIL, null, TEXT, null),
                request("n".repeat(101), EMAIL, null, TEXT, null),
                request(NAME, null, null, TEXT, null),
                request(NAME, "not-an-address", null, TEXT, null),
                request(NAME, "a@b", null, TEXT, null),
                request(NAME, "a".repeat(250) + "@example.com", null, TEXT, null),
                request(NAME, "two@example.com, three@example.com", null, TEXT, null),
                request(NAME, EMAIL, "s".repeat(151), TEXT, null),
                request(NAME, EMAIL, null, null, null),
                request(NAME, EMAIL, null, "short", null),
                request(NAME, EMAIL, null, "   short   \n\n", null),
                request(NAME, EMAIL, null, "m".repeat(5001), null),
                request(NAME, EMAIL, null, TEXT, "de"),
                request(NAME, EMAIL, null, TEXT, "../etc"));

        for (ContactMessageRequest candidate : bad) {
            assertThatThrownBy(() -> service.submit(candidate, CLIENT))
                    .isInstanceOfSatisfying(ApiException.class, e -> {
                        assertThat(e.getCode()).isEqualTo(ErrorCode.VALIDATION_ERROR);
                        assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
                        assertThat(e.getMessage()).isEqualTo("Invalid contact message");
                    });
        }
        verifyNoInteractions(repository);
        assertThat(sent).isEmpty();
    }

    @Test
    void the_limits_themselves_are_accepted() {
        ContactService service = service("");
        service.submit(request("n".repeat(100), EMAIL, "s".repeat(150), "m".repeat(10), "vi"), CLIENT);
        service.submit(request("x", EMAIL, null, "m".repeat(5000), null), CLIENT);
    }

    @Test
    void over_the_per_address_limit_is_429_and_no_mail_is_sent() {
        when(repository.insertUnlessLimited(any(), any(), any(), any(), any(), any(), any(), any(), anyInt()))
                .thenReturn(false);
        ContactService service = service(RECIPIENT);

        assertThatThrownBy(() -> service.submit(valid(), CLIENT)).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(ErrorCode.RATE_LIMITED);
            assertThat(e.getStatus()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        });
        assertThat(sent).isEmpty();
    }

    // --- Limits by client address and for the whole site ------------------------------------------------

    private static ContactMessageRequest from(String email) {
        return request(NAME, email, "Hello", TEXT, "en");
    }

    @Test
    void a_sixth_message_from_one_client_address_is_429_even_when_the_email_address_changes_every_time() {
        ContactService service = service(RECIPIENT);
        for (int i = 0; i < 5; i++) {
            service.submit(from("sender+" + i + "@example.com"), CLIENT);
        }

        assertThatThrownBy(() -> service.submit(from("sender+5@example.com"), CLIENT))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.RATE_LIMITED);
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
                });
        // Nothing of the refused message was stored or mailed.
        verify(repository, times(5))
                .insertUnlessLimited(any(), any(), any(), any(), any(), any(), any(), any(), anyInt());
        assertThat(sent).hasSize(5);
    }

    @Test
    void another_client_address_still_has_its_own_five_messages() {
        ContactService service = service("");
        for (int i = 0; i < 5; i++) {
            service.submit(from("sender+" + i + "@example.com"), CLIENT);
        }
        ClientAddress other = ClientAddress.parse("203.0.113.10").orElseThrow();

        for (int i = 0; i < 5; i++) {
            service.submit(from("other+" + i + "@example.com"), other);
        }
    }

    @Test
    void addresses_of_one_ipv6_prefix_share_the_quota_of_the_client() {
        ContactService service = service("");
        for (int i = 0; i < 5; i++) {
            service.submit(
                    from("sender+" + i + "@example.com"),
                    ClientAddress.parse("2001:db8:1:2::" + (i + 1)).orElseThrow());
        }

        assertThatThrownBy(() -> service.submit(
                        from("sender+5@example.com"),
                        ClientAddress.parse("2001:db8:1:2:ffff::1").orElseThrow()))
                .isInstanceOf(ApiException.class);
    }

    @Test
    void the_whole_site_has_a_ceiling_that_many_client_addresses_together_cannot_pass() {
        limiter = new RateLimiter(RateLimitTestProperties.with(Map.of("contact-global.per-hour", "3")));
        ContactService service = service(RECIPIENT);
        for (int i = 0; i < 3; i++) {
            service.submit(
                    from("sender+" + i + "@example.com"),
                    ClientAddress.parse("203.0.113." + i).orElseThrow());
        }

        assertThatThrownBy(() -> service.submit(
                        from("sender+3@example.com"),
                        ClientAddress.parse("198.51.100.1").orElseThrow()))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.RATE_LIMITED);
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
                });
        verify(repository, times(3))
                .insertUnlessLimited(any(), any(), any(), any(), any(), any(), any(), any(), anyInt());
        assertThat(sent).hasSize(3);
    }

    @Test
    void a_message_that_fails_validation_does_not_use_a_turn_of_the_client_limit() {
        ContactService service = service("");
        for (int i = 0; i < 20; i++) {
            assertThatThrownBy(() -> service.submit(request(NAME, EMAIL, null, "short", null), CLIENT))
                    .isInstanceOf(ApiException.class);
        }

        for (int i = 0; i < 5; i++) {
            service.submit(from("sender+" + i + "@example.com"), CLIENT);
        }
    }

    @Test
    void callers_whose_address_is_unknown_share_one_quota_apart_from_known_addresses() {
        ContactService service = service("");
        for (int i = 0; i < 5; i++) {
            service.submit(from("sender+" + i + "@example.com"), ClientAddress.UNKNOWN);
        }

        assertThatThrownBy(() -> service.submit(from("sender+5@example.com"), ClientAddress.UNKNOWN))
                .isInstanceOf(ApiException.class);
        service.submit(from("sender+6@example.com"), CLIENT);
    }

    @Test
    void without_a_recipient_the_message_is_only_stored() {
        service("").submit(valid(), CLIENT);

        assertThat(sent).isEmpty();
        stored();
    }

    @Test
    void with_a_recipient_one_plain_mail_carries_the_visitors_fields_and_a_reply_to() {
        service("  Owner@Example.com ")
                .submit(request(NAME, EMAIL, "Hello there", TEXT + "\nSecond line", "vi"), CLIENT);

        Stored stored = stored();
        assertThat(sent).hasSize(1);
        MailMessage mail = sent.getFirst();
        assertThat(mail.kind()).isEqualTo(Kind.CONTACT);
        assertThat(mail.id()).isEqualTo(stored.id());
        assertThat(mail.to()).isEqualTo(RECIPIENT);
        assertThat(mail.subject()).isEqualTo("Contact: Hello there");
        assertThat(mail.replyTo()).isEqualTo(EMAIL);
        assertThat(mail.listUnsubscribe()).isNull();
        assertThat(mail.body())
                .isEqualTo("Name: " + NAME + "\nEmail: " + EMAIL + "\nLocale: vi\n\n" + TEXT + "\nSecond line\n");
    }

    @Test
    void a_message_without_subject_gets_a_fixed_subject_and_a_dash_for_a_missing_locale() {
        service(RECIPIENT).submit(request(NAME, EMAIL, "", TEXT, null), CLIENT);

        assertThat(sent).hasSize(1);
        assertThat(sent.getFirst().subject()).isEqualTo("Contact: new message from the contact form");
        assertThat(sent.getFirst().body()).contains("\nLocale: -\n");
    }

    @Test
    void the_mail_subject_has_no_line_break_even_when_the_visitor_sent_one() {
        service(RECIPIENT).submit(request(NAME, EMAIL, "Hi\r\nBcc: attacker@example.com", TEXT, null), CLIENT);

        assertThat(sent.getFirst().subject()).doesNotContain("\r", "\n");
    }

    @Test
    void a_mail_failure_does_not_lose_the_row_or_change_the_answer_and_logs_only_id_and_code() {
        transport = message -> {
            throw new MailTransportException(MailFailure.CONNECTION_FAILED);
        };

        service(RECIPIENT).submit(valid(), CLIENT);

        Stored stored = stored();
        List<ILoggingEvent> warnings =
                logs.list.stream().filter(e -> e.getLevel() == Level.WARN).toList();
        assertThat(warnings).hasSize(1);
        assertThat(warnings.getFirst().getFormattedMessage())
                .isEqualTo("contact mail not sent: id=" + stored.id() + " code=CONNECTION_FAILED");
        LogAssertions.assertNoValues(logs.list, NAME, EMAIL, TEXT, "Hello", RECIPIENT);
    }

    @Test
    void an_unexpected_transport_error_is_also_contained_and_never_echoes_its_message() {
        transport = message -> {
            throw new IllegalStateException("boom " + EMAIL + " " + TEXT);
        };

        service(RECIPIENT).submit(valid(), CLIENT);

        Stored stored = stored();
        assertThat(logs.list.stream().filter(e -> e.getLevel() == Level.WARN).map(ILoggingEvent::getFormattedMessage))
                .containsExactly("contact mail not sent: id=" + stored.id() + " code=UNEXPECTED");
        LogAssertions.assertNoValues(logs.list, NAME, EMAIL, TEXT);
    }

    @Test
    void a_recipient_that_is_not_one_valid_address_stops_the_start_without_printing_it() {
        assertThatThrownBy(() -> service("owner at example"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("CONTACT_RECIPIENT")
                .hasMessageNotContaining("owner at example");
        assertThatThrownBy(() -> service("a@example.com, b@example.com")).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void properties_do_not_print_the_recipient() {
        assertThat(new ContactProperties(RECIPIENT).toString()).doesNotContain(RECIPIENT);
        assertThat(new ContactProperties(null).recipient()).isEmpty();
    }

    @Test
    void the_request_does_not_print_what_the_visitor_typed() {
        assertThat(valid().toString()).doesNotContain(NAME, EMAIL, TEXT);
    }
}
