package com.blog.newsletter.service;

import com.blog.auth.oauth.GithubOAuthProperties;
import com.blog.common.i18n.Languages;
import com.blog.common.text.UserText;
import com.blog.newsletter.mail.MailMessage;
import com.blog.newsletter.mail.MailMessage.Kind;
import com.blog.newsletter.repository.NewsletterRepository.DueDelivery;
import java.util.Locale;
import java.util.UUID;
import org.springframework.context.MessageSource;
import org.springframework.context.support.ResourceBundleMessageSource;
import org.springframework.stereotype.Component;

/**
 * The text of the two kinds of mail, plain text (V31), in the language of the recipient (V9): the wording lives in
 * {@code i18n/newsletter_*.properties}. Every link is built from {@code SITE_URL}: the confirm and unsubscribe pages and
 * the post in the mail body (with a locale prefix unless it is the default locale), the BFF route for
 * {@code List-Unsubscribe} (never prefixed). With smtp, NewsletterConfig has already required SITE_URL to be a public
 * https URL; when empty (dev machines, IT) the links are relative paths, and the log transport does not send them.
 */
@Component
public class NewsletterComposer {

    private final String siteUrl;
    private final NewsletterTokens tokens;
    private final Languages languages;
    private final MessageSource messages;

    public NewsletterComposer(GithubOAuthProperties oauth, NewsletterTokens tokens, Languages languages) {
        this.siteUrl = oauth.siteUrl().replaceAll("/+$", "");
        this.tokens = tokens;
        this.languages = languages;
        ResourceBundleMessageSource bundle = new ResourceBundleMessageSource();
        bundle.setBasename("i18n/newsletter");
        bundle.setDefaultEncoding("UTF-8");
        bundle.setDefaultLocale(Locale.ENGLISH);
        this.messages = bundle;
    }

    public MailMessage confirmation(UUID subscriberId, String email, String locale, String confirmationToken) {
        Locale lang = Locale.forLanguageTag(locale);
        String unsubscribeToken = tokens.unsubscribeToken(subscriberId);
        String body = text(
                lang,
                "confirmation.body",
                pageLink(locale, "/newsletter/confirm", confirmationToken),
                pageLink(locale, "/newsletter/unsubscribe", unsubscribeToken));
        return new MailMessage(
                Kind.CONFIRMATION,
                subscriberId,
                email,
                text(lang, "confirmation.subject"),
                body,
                oneClickLink(unsubscribeToken));
    }

    /** The longest excerpt a mail carries, in code points; the post may hold more (old rows, imports). */
    static final int MAX_EXCERPT = 300;

    private static final char ELLIPSIS = (char) 0x2026;

    /**
     * The subject of a new-post mail: the title as one line. A control character (a line break would end a mail header
     * early), an invisible or text-direction character is removed, runs of white space become one space.
     */
    public static String mailTitle(String title) {
        return UserText.cleanName(title);
    }

    /**
     * The excerpt of a new-post mail: cleaned like a comment and cut at {@value #MAX_EXCERPT} code points with an ellipsis.
     * Null when the post has none.
     */
    public static String mailExcerpt(String excerpt) {
        if (excerpt == null) {
            return null;
        }
        String cleaned = UserText.clean(excerpt);
        if (cleaned.isEmpty()) {
            return null;
        }
        if (cleaned.codePointCount(0, cleaned.length()) <= MAX_EXCERPT) {
            return cleaned;
        }
        return cleaned.substring(0, cleaned.offsetByCodePoints(0, MAX_EXCERPT - 1))
                        .stripTrailing()
                + ELLIPSIS;
    }

    public MailMessage issue(DueDelivery delivery) {
        Locale lang = Locale.forLanguageTag(delivery.locale());
        String unsubscribeToken = tokens.unsubscribeToken(delivery.subscriberId());
        String title = mailTitle(delivery.title());
        String excerpt = mailExcerpt(delivery.excerpt());
        StringBuilder body = new StringBuilder(title).append("\n\n");
        if (excerpt != null) {
            body.append(excerpt).append("\n\n");
        }
        body.append(text(lang, "issue.read", siteUrl + prefix(delivery.locale()) + "/posts/" + delivery.slug()))
                .append("\n\n")
                .append("--\n")
                .append(text(lang, "issue.reason"))
                .append('\n')
                .append(text(
                        lang,
                        "issue.unsubscribe",
                        pageLink(delivery.locale(), "/newsletter/unsubscribe", unsubscribeToken)))
                .append('\n');
        return new MailMessage(
                Kind.ISSUE, delivery.id(), delivery.email(), title, body.toString(), oneClickLink(unsubscribeToken));
    }

    private String text(Locale lang, String key, Object... args) {
        return messages.getMessage(key, args, lang);
    }

    /** The default locale has no prefix in the site's URLs. */
    private String prefix(String locale) {
        return locale.equals(languages.defaultLocale()) ? "" : "/" + locale;
    }

    /** The token is base64url: no further encoding is needed in the query. */
    private String pageLink(String locale, String path, String token) {
        return siteUrl + prefix(locale) + path + "?token=" + token;
    }

    /** The BFF route is not a page: it never has a locale prefix. */
    private String oneClickLink(String token) {
        return siteUrl + "/api/newsletter/unsubscribe?token=" + token;
    }
}
