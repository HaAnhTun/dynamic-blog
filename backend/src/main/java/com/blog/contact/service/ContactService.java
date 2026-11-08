package com.blog.contact.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.Languages;
import com.blog.common.ratelimit.ClientAddress;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.contact.config.ContactProperties;
import com.blog.contact.dto.ContactMessageRequest;
import com.blog.contact.repository.ContactMessageRepository;
import com.blog.newsletter.mail.MailMessage;
import com.blog.newsletter.mail.MailMessage.Kind;
import com.blog.newsletter.mail.MailTransport;
import com.blog.newsletter.mail.MailTransportException;
import com.blog.newsletter.service.EmailAddresses;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Locale;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * The public contact form. The message is stored first and is never lost: when a recipient is configured
 * ({@code CONTACT_RECIPIENT}) one plain-text mail is sent afterwards, through the same transport as the newsletter, and
 * a failure of that mail is logged with a safe code and does not change the answer. Nothing the visitor typed (name,
 * address, subject, text) is ever logged: at most the message id.
 */
@Service
public class ContactService {

    private static final Logger log = LoggerFactory.getLogger(ContactService.class);

    static final int NAME_MAX = 100;
    static final int SUBJECT_MAX = 150;
    static final int MESSAGE_MIN = 10;
    static final int MESSAGE_MAX = 5000;
    /** At most this many messages per address in {@link #WINDOW}. */
    static final int MAX_PER_ADDRESS = 5;

    static final Duration WINDOW = Duration.ofHours(1);
    static final String SUBJECT_PREFIX = "Contact: ";
    static final String SUBJECT_FALLBACK = "new message from the contact form";

    private static final int LINE_SEPARATOR = 0x2028;
    private static final int PARAGRAPH_SEPARATOR = 0x2029;

    private final ContactMessageRepository repository;
    private final MailTransport mailTransport;
    private final Languages languages;
    private final RateLimiter rateLimiter;
    private final Clock clock;
    /** The validated {@code CONTACT_RECIPIENT}; null when mail is off. */
    private final String recipient;

    /** @throws IllegalStateException when {@code CONTACT_RECIPIENT} is set and is not one valid address (the value is not in the message) */
    public ContactService(
            ContactMessageRepository repository,
            MailTransport mailTransport,
            Languages languages,
            RateLimiter rateLimiter,
            Clock clock,
            ContactProperties properties) {
        this.repository = repository;
        this.mailTransport = mailTransport;
        this.languages = languages;
        this.rateLimiter = rateLimiter;
        this.clock = clock;
        if (properties.recipient().isEmpty()) {
            this.recipient = null;
        } else {
            this.recipient = EmailAddresses.normalize(properties.recipient())
                    .orElseThrow(() -> new IllegalStateException(
                            "CONTACT_RECIPIENT must be one valid email address, or empty to only store the messages."));
        }
    }

    /**
     * Validates, stores, then mails the copy.
     *
     * Three limits, cheapest first, each one the same 429: the sender's client address (a trusted forwarded address, else
     * the socket address, see ClientAddressResolver; counted for every well-formed message, so rotating the email
     * address does not help), then the whole site (so many addresses together cannot flood the inbox or the mail
     * recipient), then the submitted email address (a SQL count, persistent).
     *
     * @param client where the request comes from
     * @throws ApiException 400 {@code VALIDATION_ERROR} (one generic message for every bad field); 429
     *                      {@code RATE_LIMITED} when the client address or the whole site is over its hourly limit, or
     *                      the email address already sent {@value #MAX_PER_ADDRESS} messages in the last hour
     */
    public void submit(ContactMessageRequest request, ClientAddress client) {
        String name = singleLine(request.name());
        String email = EmailAddresses.normalize(request.email()).orElseThrow(ContactService::invalid);
        String subject = singleLine(request.subject());
        String message = text(request.message());
        if (name.isEmpty()
                || name.length() > NAME_MAX
                || subject.length() > SUBJECT_MAX
                || message.length() < MESSAGE_MIN
                || message.length() > MESSAGE_MAX) {
            throw invalid();
        }
        String locale = locale(request.locale());
        String storedSubject = subject.isEmpty() ? null : subject;

        rateLimiter.check(RateLimiter.CONTACT_CLIENT, client.key());
        rateLimiter.check(RateLimiter.CONTACT_GLOBAL, RateLimiter.GLOBAL_KEY);

        UUID id = UUID.randomUUID();
        Instant now = clock.instant();
        boolean stored = repository.insertUnlessLimited(
                id, name, email, storedSubject, message, locale, now, now.minus(WINDOW), MAX_PER_ADDRESS);
        if (!stored) {
            throw new ApiException(
                    ErrorCode.RATE_LIMITED,
                    HttpStatus.TOO_MANY_REQUESTS,
                    "Too many requests; wait a moment and try again");
        }
        sendCopy(id, name, email, storedSubject, message, locale);
    }

    /** Absent or blank is no locale (null); anything else must be an enabled one, else the same generic 400 as every other field. */
    private String locale(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String code = raw.strip().toLowerCase(Locale.ROOT);
        if (!languages.isEnabled(code)) {
            throw invalid();
        }
        return code;
    }

    /** Never throws: the row is already stored. Only the message id and a safe failure code are logged. */
    private void sendCopy(UUID id, String name, String email, String subject, String message, String locale) {
        if (recipient == null) {
            return;
        }
        String body = "Name: " + name + "\nEmail: " + email + "\nLocale: " + (locale == null ? "-" : locale) + "\n\n"
                + message + "\n";
        MailMessage mail = new MailMessage(
                Kind.CONTACT,
                id,
                recipient,
                SUBJECT_PREFIX + (subject == null ? SUBJECT_FALLBACK : subject),
                body,
                null,
                email);
        try {
            mailTransport.send(mail);
        } catch (MailTransportException e) {
            log.warn("contact mail not sent: id={} code={}", id, e.failure());
        } catch (RuntimeException e) {
            log.warn("contact mail not sent: id={} code=UNEXPECTED", id);
        }
    }

    /**
     * A name or a subject: every control character (CR, LF, tab, other C0, DEL, C1) and the Unicode line and paragraph
     * separators are removed, so it can never break a mail header; then trimmed.
     */
    static String singleLine(String raw) {
        if (raw == null) {
            return "";
        }
        StringBuilder out = new StringBuilder(raw.length());
        raw.codePoints().filter(cp -> !isControl(cp)).forEach(out::appendCodePoint);
        return out.toString().strip();
    }

    /**
     * The message text: line breaks are kept (CRLF and CR become LF) and so is the tab; every other control character,
     * NUL included (PostgreSQL text cannot hold it), is removed; then trimmed.
     */
    static String text(String raw) {
        if (raw == null) {
            return "";
        }
        String unified = raw.replace("\r\n", "\n").replace('\r', '\n');
        StringBuilder out = new StringBuilder(unified.length());
        unified.codePoints()
                .filter(cp -> cp == '\n' || cp == '\t' || !isControl(cp))
                .forEach(out::appendCodePoint);
        return out.toString().strip();
    }

    private static boolean isControl(int codePoint) {
        return Character.isISOControl(codePoint) || codePoint == LINE_SEPARATOR || codePoint == PARAGRAPH_SEPARATOR;
    }

    private static ApiException invalid() {
        return new ApiException(ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "Invalid contact message");
    }
}
