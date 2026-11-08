package com.blog.common.text;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.fixtures.vi.IdentityViText;
import org.junit.jupiter.api.Test;

/**
 * The LIKE pattern "contains this string" of the admin-page search box: lowercase, LIKE wildcard characters are all
 * escaped, so a person typing {@code 50%} searches exactly "50%" and not "50 followed by anything".
 */
class LikePatternTest {

    private static String cp(int... codePoints) {
        return new String(codePoints, 0, codePoints.length);
    }

    @Test
    void search_string_is_placed_between_two_percent_signs_and_lowercased() {
        assertThat(LikePattern.contains("Spring BOOT")).isEqualTo("%spring boot%");
        assertThat(LikePattern.contains(IdentityViText.READER_TITLE))
                .isEqualTo("%" + IdentityViText.READER_LOWER + "%");
    }

    @Test
    void percent_underscore_and_backslash_are_escaped_with_backslash() {
        assertThat(LikePattern.contains("50%")).isEqualTo("%50\\%%");
        assertThat(LikePattern.contains(IdentityViText.WORD_TEN + "_" + IdentityViText.WORD_BIEN))
                .isEqualTo("%" + IdentityViText.WORD_TEN + "\\_" + IdentityViText.WORD_BIEN + "%");
        assertThat(LikePattern.contains("C:\\temp")).isEqualTo("%c:\\\\temp%");
        // Backslash is escaped first: it does not escape the characters just added a second time.
        assertThat(LikePattern.contains("\\%_")).isEqualTo("%\\\\\\%\\_%");
        assertThat(LikePattern.ESCAPE).isEqualTo('\\');
    }

    @Test
    void string_is_cleaned_like_comment_content_before_searching() {
        // The stored content is after UserText.clean: pasting exactly the string that was seen finds it, even if it
        // carries invisible characters or
        // NUL (Postgres rejects NUL in text, so without cleaning the search becomes a 500 error).
        assertThat(LikePattern.contains("  " + IdentityViText.WORD_BINH + cp(0x200B) + " " + IdentityViText.WORD_LUAN
                        + cp(0x00) + "\r\n"))
                .isEqualTo("%" + IdentityViText.WORD_BINH + " " + IdentityViText.WORD_LUAN + "%");
    }

    @Test
    void empty_blank_or_null_is_no_search() {
        assertThat(LikePattern.contains(null)).isNull();
        assertThat(LikePattern.contains("")).isNull();
        assertThat(LikePattern.contains("  \t\n ")).isNull();
        assertThat(LikePattern.contains(cp(0x200B, 0xFEFF))).isNull();
    }
}
