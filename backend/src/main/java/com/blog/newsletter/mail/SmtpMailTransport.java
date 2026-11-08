package com.blog.newsletter.mail;

import com.blog.common.text.UserText;
import com.blog.newsletter.service.EmailAddresses;
import jakarta.mail.MessagingException;
import jakarta.mail.internet.AddressException;
import jakarta.mail.internet.InternetAddress;
import jakarta.mail.internet.MimeMessage;
import java.nio.charset.StandardCharsets;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;

/**
 * Really sends over SMTP ({@code spring.mail.*}), only when {@code NEWSLETTER_TRANSPORT=smtp}. Plain UTF-8 text, the
 * sender is {@code NEWSLETTER_FROM}, with {@code List-Unsubscribe} and {@code List-Unsubscribe-Post} (RFC 8058) so the
 * mailbox shows a one-click unsubscribe button (only for a mail that has an unsubscribe link: the contact mail has none),
 * and {@code Reply-To} when the mail has one (the contact mail: the visitor's address). An error becomes a {@link MailTransportException} carrying only a safe code.
 */
public class SmtpMailTransport implements MailTransport {

    private final JavaMailSender sender;
    private final InternetAddress from;

    public SmtpMailTransport(JavaMailSender sender, InternetAddress from) {
        this.sender = sender;
        this.from = from;
    }

    /**
     * The recipient and the Reply-To are plain addresses ({@link EmailAddresses}: one address, ASCII, no display name, no
     * encoded word), checked again here because a stored address was accepted by an older rule.
     */
    private static void requirePlainAddress(String address) throws AddressException {
        if (EmailAddresses.normalize(address).isEmpty()) {
            throw new AddressException("Not a plain address");
        }
    }

    @Override
    public void send(MailMessage message) {
        try {
            requirePlainAddress(message.to());
            if (message.replyTo() != null) {
                requirePlainAddress(message.replyTo());
            }
            MimeMessage mime = sender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(mime, false, StandardCharsets.UTF_8.name());
            helper.setFrom(from);
            helper.setTo(message.to());
            // A subject can come from a post title, which an author writes: the library folds a line break, but the
            // rule
            // is stated here, in the one place every mail passes through, and not left to a library default.
            helper.setSubject(UserText.cleanName(message.subject()));
            helper.setText(message.body(), false);
            if (message.replyTo() != null) {
                helper.setReplyTo(message.replyTo());
            }
            if (message.listUnsubscribe() != null) {
                mime.setHeader("List-Unsubscribe", "<" + message.listUnsubscribe() + ">");
                mime.setHeader("List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
            }
            sender.send(mime);
        } catch (MessagingException | RuntimeException e) {
            // Spring MailException and every other error: the message may echo an address, so only the code goes on.
            throw new MailTransportException(MailFailure.classify(e));
        }
    }
}
