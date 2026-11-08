package com.blog.newsletter.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.auth.oauth.GithubOAuthProperties;
import com.blog.common.i18n.I18nProperties;
import com.blog.common.i18n.Languages;
import com.blog.newsletter.mail.MailMessage;
import com.blog.newsletter.repository.NewsletterRepository.DueDelivery;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * The text of a new-post mail comes from an author, so the composer bounds it: a subject is one line (a line break would
 * end a mail header early), an excerpt is cut, and invisible or text-direction characters never reach a subscriber.
 */
class NewsletterComposerTest {

    private final NewsletterComposer composer = new NewsletterComposer(
            new GithubOAuthProperties("", "", "", "https://blog.example.test", null),
            new NewsletterTokens("k".repeat(32).getBytes(StandardCharsets.UTF_8)),
            new Languages(new I18nProperties(List.of("vi", "en"), "vi")));

    private static String cp(int codePoint) {
        return new String(Character.toChars(codePoint));
    }

    private MailMessage mail(String title, String excerpt) {
        return composer.issue(new DueDelivery(
                UUID.randomUUID(), 0, UUID.randomUUID(), "reader@example.test", "en", "a-post", title, excerpt));
    }

    @Test
    void a_title_with_a_line_break_gives_a_one_line_subject() {
        MailMessage mail = mail("First line\r\nBcc: someone@example.test", "Summary");

        assertThat(mail.subject()).isEqualTo("First line Bcc: someone@example.test");
        assertThat(mail.subject()).doesNotContain("\r").doesNotContain("\n");
        assertThat(mail.body()).startsWith("First line Bcc: someone@example.test\n\n");
    }

    @Test
    void text_direction_and_invisible_characters_are_removed_from_the_subject_and_the_excerpt() {
        MailMessage mail = mail("Invoice" + cp(0x202E) + "gpj.exe", "Sum" + cp(0x200B) + "mary");

        assertThat(mail.subject()).isEqualTo("Invoicegpj.exe");
        assertThat(mail.body()).contains("Summary").doesNotContain(cp(0x202E)).doesNotContain(cp(0x200B));
    }

    @Test
    void an_excerpt_of_ten_thousand_characters_is_cut_to_the_cap_with_an_ellipsis() {
        MailMessage mail = mail("A title", "word ".repeat(2_000));

        String excerpt = NewsletterComposer.mailExcerpt("word ".repeat(2_000));
        assertThat(excerpt.codePointCount(0, excerpt.length())).isLessThanOrEqualTo(NewsletterComposer.MAX_EXCERPT);
        assertThat(excerpt).endsWith(cp(0x2026));
        assertThat(mail.body()).contains(excerpt);
        assertThat(mail.body().length()).isLessThan(1_500);
    }

    @Test
    void a_short_excerpt_is_kept_whole_and_a_missing_or_blank_one_is_left_out() {
        assertThat(NewsletterComposer.mailExcerpt("A short summary.")).isEqualTo("A short summary.");
        assertThat(NewsletterComposer.mailExcerpt(null)).isNull();
        assertThat(NewsletterComposer.mailExcerpt("  \n ")).isNull();
        assertThat(mail("A title", null).body()).startsWith("A title\n\n");
    }

    @Test
    void the_cut_never_splits_a_surrogate_pair() {
        String emoji = cp(0x1F600);
        String excerpt = NewsletterComposer.mailExcerpt(emoji.repeat(NewsletterComposer.MAX_EXCERPT + 50));

        assertThat(excerpt.codePointCount(0, excerpt.length())).isEqualTo(NewsletterComposer.MAX_EXCERPT);
        assertThat(excerpt.chars().filter(c -> Character.isSurrogate((char) c)).count() % 2)
                .isZero();
    }
}
