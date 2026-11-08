package com.blog.newsletter.mail;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.fixtures.vi.SocialVi;
import com.blog.newsletter.mail.MailMessage.Kind;
import jakarta.mail.AuthenticationFailedException;
import jakarta.mail.MessagingException;
import jakarta.mail.SendFailedException;
import jakarta.mail.internet.AddressException;
import jakarta.mail.internet.InternetAddress;
import jakarta.mail.internet.MimeMessage;
import java.net.ConnectException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.mail.MailAuthenticationException;
import org.springframework.mail.MailException;
import org.springframework.mail.MailSendException;
import org.springframework.mail.javamail.JavaMailSenderImpl;

/**
 * The two real newsletter transports, opening no connection: the sender of SmtpMailTransport is a JavaMailSenderImpl
 * whose send step is replaced, so the mail is fully built and then stops in memory. A send failure leaves only a safe code.
 */
class MailTransportTest {

    private static final String ADDRESS = "doc-gia-bi-mat@example.com";
    private static final String TOKEN = "tokenBiMatKhongDuocVaoLogAbcdefghijklmnop";
    private static final MailMessage MESSAGE = new MailMessage(
            Kind.ISSUE,
            UUID.randomUUID(),
            ADDRESS,
            SocialVi.MAIL_SUBJECT,
            SocialVi.MAIL_BODY,
            "https://blog.example.com/api/newsletter/unsubscribe?token=" + TOKEN);

    /** A sender that never touches the network: it keeps the mail, or throws a given error as JavaMailSenderImpl would. */
    private static final class CapturingSender extends JavaMailSenderImpl {
        final List<MimeMessage> sent = new ArrayList<>();
        MailException failure;

        @Override
        protected void doSend(MimeMessage[] mimeMessages, Object[] originalMessages) {
            if (failure != null) {
                throw failure;
            }
            for (MimeMessage message : mimeMessages) {
                try {
                    // As the real doSend does right before handing over to the mail server: the headers are finalized.
                    message.saveChanges();
                } catch (MessagingException e) {
                    throw new IllegalStateException(e);
                }
                sent.add(message);
            }
        }
    }

    @Test
    void smtp_mail_is_plain_utf8_text_from_newsletter_from_with_one_click_unsubscribe_header() throws Exception {
        CapturingSender sender = new CapturingSender();
        new SmtpMailTransport(sender, new InternetAddress("Blog <newsletter@example.com>", true)).send(MESSAGE);

        assertThat(sender.sent).hasSize(1);
        MimeMessage mime = sender.sent.getFirst();
        assertThat(mime.getFrom()).extracting(Object::toString).containsExactly("Blog <newsletter@example.com>");
        assertThat(mime.getAllRecipients()).extracting(Object::toString).containsExactly(ADDRESS);
        assertThat(mime.getSubject()).isEqualTo(SocialVi.MAIL_SUBJECT);
        assertThat(mime.getContentType()).startsWith("text/plain").containsIgnoringCase("charset=UTF-8");
        assertThat(mime.getContent()).isEqualTo(MESSAGE.body());
        assertThat(mime.getHeader("List-Unsubscribe")).containsExactly("<" + MESSAGE.listUnsubscribe() + ">");
        assertThat(mime.getHeader("List-Unsubscribe-Post")).containsExactly("List-Unsubscribe=One-Click");
    }

    @Test
    void send_failure_leaves_only_a_safe_code_no_cause_no_provider_message() {
        CapturingSender sender = new CapturingSender();
        sender.failure = new MailSendException(
                "550 5.1.1 <" + ADDRESS + ">: Recipient address rejected",
                new SendFailedException("Invalid Addresses " + ADDRESS));
        SmtpMailTransport transport = new SmtpMailTransport(sender, address("newsletter@example.com"));

        assertThatThrownBy(() -> transport.send(MESSAGE)).isInstanceOfSatisfying(MailTransportException.class, e -> {
            assertThat(e.failure()).isEqualTo(MailFailure.REJECTED);
            assertThat(e).hasMessage("REJECTED").hasNoCause();
        });
        // A recipient that cannot be built into a mail (two addresses in one): also just a code.
        assertThatThrownBy(() -> transport.send(new MailMessage(
                        Kind.CONFIRMATION,
                        UUID.randomUUID(),
                        "mot@example.com, hai@example.com",
                        "Subject",
                        "Body",
                        "https://blog.example.com/x")))
                .isInstanceOfSatisfying(
                        MailTransportException.class,
                        e -> assertThat(e.failure()).isEqualTo(MailFailure.INVALID_ADDRESS));
    }

    @Test
    void line_breaks_in_a_subject_cannot_add_a_header_or_a_recipient() throws Exception {
        CapturingSender sender = new CapturingSender();
        SmtpMailTransport transport = new SmtpMailTransport(sender, address("newsletter@example.com"));
        // A subject comes from a post title, which an author writes: CR LF must not start a new header line.
        for (String subject : new String[] {
            "Hello\r\nBcc: x@example.com",
            "Hello\nBcc: x@example.com",
            "Hello\rBcc: x@example.com",
            "Hello\u2028Bcc: x@example.com"
        }) {
            sender.sent.clear();

            transport.send(new MailMessage(
                    Kind.ISSUE, UUID.randomUUID(), ADDRESS, subject, "Body", "https://blog.example.com/x"));

            MimeMessage mime = sender.sent.getFirst();
            assertThat(mime.getHeader("Bcc")).isNull();
            assertThat(mime.getAllRecipients()).extracting(Object::toString).containsExactly(ADDRESS);
            assertThat(mime.getSubject())
                    .doesNotContain("\r")
                    .doesNotContain("\n")
                    .doesNotContain("\u2028");
            assertThat(mime.getSubject()).startsWith("Hello").endsWith("x@example.com");
        }
    }

    @Test
    void a_recipient_or_reply_to_that_is_not_a_plain_address_is_refused_with_a_code_and_never_sent() {
        CapturingSender sender = new CapturingSender();
        SmtpMailTransport transport = new SmtpMailTransport(sender, address("newsletter@example.com"));

        // An RFC 2047 encoded word in the local part would be decoded by a mail client, not read as an address.
        for (String bad :
                new String[] {"=?utf-8?q?x?=@example.com", "Name <a@example.com>", "a@example.com\r\nBcc: b@example.com"
                }) {
            assertThatThrownBy(() -> transport.send(new MailMessage(
                            Kind.ISSUE, UUID.randomUUID(), bad, "Subject", "Body", "https://blog.example.com/x")))
                    .isInstanceOfSatisfying(
                            MailTransportException.class,
                            e -> assertThat(e.failure()).isEqualTo(MailFailure.INVALID_ADDRESS));
            assertThatThrownBy(() -> transport.send(
                            new MailMessage(Kind.CONTACT, UUID.randomUUID(), ADDRESS, "Subject", "Body", null, bad)))
                    .isInstanceOfSatisfying(
                            MailTransportException.class,
                            e -> assertThat(e.failure()).isEqualTo(MailFailure.INVALID_ADDRESS));
        }
        assertThat(sender.sent).isEmpty();
    }

    @Test
    void error_code_is_read_from_the_error_type_and_its_causes() {
        assertThat(MailFailure.classify(new MailSendException(
                        "Mail server connection failed",
                        new MessagingException("Couldn't connect to host", new ConnectException("refused")))))
                .isEqualTo(MailFailure.CONNECTION_FAILED);
        assertThat(MailFailure.classify(new MessagingException("x", new UnknownHostException("smtp.example"))))
                .isEqualTo(MailFailure.CONNECTION_FAILED);
        assertThat(MailFailure.classify(new MessagingException("x", new SocketTimeoutException("Read timed out"))))
                .isEqualTo(MailFailure.TIMEOUT);
        assertThat(MailFailure.classify(new MailAuthenticationException(new AuthenticationFailedException("535"))))
                .isEqualTo(MailFailure.AUTH_FAILED);
        assertThat(MailFailure.classify(new AddressException("Illegal address", ADDRESS)))
                .isEqualTo(MailFailure.INVALID_ADDRESS);
        // JavaMailSenderImpl collects per-mail failures into getMessageExceptions without setting a cause.
        SendFailedException rejectedRecipient =
                new SendFailedException("550", null, null, null, new jakarta.mail.Address[] {address(ADDRESS)});
        assertThat(MailFailure.classify(new MailSendException(Map.of(new Object(), rejectedRecipient))))
                .isEqualTo(MailFailure.INVALID_ADDRESS);
        assertThat(MailFailure.classify(new MessagingException("554 Message rejected")))
                .isEqualTo(MailFailure.UNKNOWN);
        assertThat(MailFailure.classify(new IllegalStateException(ADDRESS))).isEqualTo(MailFailure.UNKNOWN);

        assertThat(MailFailure.values())
                .filteredOn(MailFailure::providerWide)
                .containsExactly(MailFailure.CONNECTION_FAILED, MailFailure.TIMEOUT, MailFailure.AUTH_FAILED);
    }

    @Test
    void log_transport_sends_nothing_and_only_records_the_mail_kind_with_id() {
        Logger logger = (Logger) LoggerFactory.getLogger(LoggingMailTransport.class);
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        logger.addAppender(logs);
        try {
            new LoggingMailTransport().send(MESSAGE);
        } finally {
            logger.detachAppender(logs);
        }

        assertThat(logs.list)
                .singleElement()
                .satisfies(event -> assertThat(event.getFormattedMessage())
                        .contains("ISSUE", MESSAGE.id().toString())
                        .doesNotContain(ADDRESS, TOKEN, "Spring Boot 4", "https://", "unsubscribe"));
        // The mail's record also prints nothing private, in case someone logs it by mistake.
        assertThat(MESSAGE.toString()).doesNotContain(ADDRESS, TOKEN, "Spring Boot 4");
    }

    @Test
    void contact_mail_carries_reply_to_and_no_unsubscribe_headers_while_newsletter_mail_has_no_reply_to()
            throws Exception {
        CapturingSender sender = new CapturingSender();
        SmtpMailTransport transport = new SmtpMailTransport(sender, address("Blog <newsletter@example.com>"));
        MailMessage contact = new MailMessage(
                Kind.CONTACT,
                UUID.randomUUID(),
                "owner@example.com",
                "Contact: Hello",
                "Name: Visitor\nEmail: visitor@example.com\n\nA message body.\n",
                null,
                "visitor@example.com");

        transport.send(contact);
        transport.send(MESSAGE);

        MimeMessage contactMime = sender.sent.get(0);
        assertThat(contactMime.getFrom()).extracting(Object::toString).containsExactly("Blog <newsletter@example.com>");
        assertThat(contactMime.getAllRecipients()).extracting(Object::toString).containsExactly("owner@example.com");
        assertThat(contactMime.getReplyTo()).extracting(Object::toString).containsExactly("visitor@example.com");
        assertThat(contactMime.getHeader("List-Unsubscribe")).isNull();
        assertThat(contactMime.getHeader("List-Unsubscribe-Post")).isNull();
        assertThat(contactMime.getContent()).isEqualTo(contact.body());
        // The newsletter mail is unchanged: the one-click headers stay and nobody is asked to reply to a visitor. With
        // no Reply-To header, JavaMail answers with the sender.
        MimeMessage newsletterMime = sender.sent.get(1);
        assertThat(newsletterMime.getHeader("Reply-To")).isNull();
        assertThat(newsletterMime.getHeader("List-Unsubscribe")).containsExactly("<" + MESSAGE.listUnsubscribe() + ">");
        // The record prints neither an address nor the visitor's text.
        assertThat(contact.toString())
                .isEqualTo("MailMessage[kind=CONTACT, id=" + contact.id() + "]")
                .doesNotContain("owner@example.com", "visitor@example.com", "A message body");
    }

    private static InternetAddress address(String value) {
        try {
            return new InternetAddress(value, true);
        } catch (AddressException e) {
            throw new IllegalArgumentException(e);
        }
    }
}
