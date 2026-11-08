package com.blog.notification.service;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/**
 * Comment excerpt in a notification: one line, whitespace collapsed, at most 120 code
 * points,
 * "…" only when really cut, and never splitting a surrogate pair in two.
 *
 * Special characters are built from code points ({@link #cp}), as in CommentContentTest: invisible characters
 * written straight into the source cannot be read by anyone.
 */
class NotificationExcerptTest {

    private static final String ELLIPSIS = cp(0x2026);
    /** 😀, outside the BMP: two UTF-16 units, one code point. */
    private static final String EMOJI = cp(0x1F600);

    private static String cp(int... codePoints) {
        return new String(codePoints, 0, codePoints.length);
    }

    private static int codePoints(String text) {
        return text.codePointCount(0, text.length());
    }

    @Test
    void adjacent_whitespace_collapses_to_one_space_and_both_ends_are_trimmed() {
        assertThat(NotificationExcerpt.of("  Great post\n\nindeed!\tThanks   to the author.  "))
                .isEqualTo("Great post indeed! Thanks to the author.");
        // Non-breaking spaces and the whitespace of CJK text are whitespace too; the default \s of Java does
        // not match them.
        assertThat(NotificationExcerpt.of("one" + cp(0x00A0, 0x00A0) + "two" + cp(0x3000) + "three" + cp(0x2028)))
                .isEqualTo("one two three");
    }

    @Test
    void exactly_120_code_points_is_returned_whole_without_ellipsis() {
        String exact = "a".repeat(120);

        assertThat(NotificationExcerpt.of(exact)).isEqualTo(exact);
        assertThat(NotificationExcerpt.of("short")).isEqualTo("short").doesNotContain(ELLIPSIS);
    }

    @Test
    void from_121_code_points_it_is_cut_at_120_and_ellipsis_added() {
        String excerpt = NotificationExcerpt.of("a".repeat(121));

        assertThat(excerpt).isEqualTo("a".repeat(120) + ELLIPSIS);
        assertThat(codePoints(excerpt)).isEqualTo(121);
        assertThat(NotificationExcerpt.of("b".repeat(2000))).isEqualTo("b".repeat(120) + ELLIPSIS);
    }

    @Test
    void counts_by_code_point_and_never_splits_a_surrogate_pair() {
        // 120 emoji are 240 chars in Java and still fit, as CommentContent counts.
        String fits = EMOJI.repeat(120);
        assertThat(NotificationExcerpt.of(fits)).isEqualTo(fits);

        String cut = NotificationExcerpt.of("x" + EMOJI.repeat(120));
        // The 120th code point is a whole emoji; no half surrogate pair is left at the end.
        assertThat(cut).isEqualTo("x" + EMOJI.repeat(119) + ELLIPSIS);
        assertThat(cut.chars()
                        .filter(ch -> Character.isHighSurrogate((char) ch))
                        .count())
                .isEqualTo(cut.chars()
                        .filter(ch -> Character.isLowSurrogate((char) ch))
                        .count());
    }

    @Test
    void whitespace_is_collapsed_before_counting_and_trailing_space_of_the_cut_is_dropped() {
        // 180 characters submitted, but collapsed they are only 119 code points: not cut.
        assertThat(NotificationExcerpt.of("a \n".repeat(60))).isEqualTo("a ".repeat(59) + "a");
        // The cut falls right after a space: no "… " is left dangling after the space.
        assertThat(NotificationExcerpt.of("a".repeat(119) + " " + "b".repeat(10)))
                .isEqualTo("a".repeat(119) + ELLIPSIS);
    }
}
