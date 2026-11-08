package com.blog.common.text;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.fixtures.vi.IdentityViText;
import org.junit.jupiter.api.Test;

/**
 * Normalization of text sent by readers: comment content ({@link UserText#clean}) and the display name taken from
 * GitHub ({@link UserText#cleanName}).
 *
 * Special characters are built from code points ({@link #cp}), not written directly in the source: an invisible or text-direction-reversing
 * character in the test file cannot be read by anyone, and strings that "look the same" may not be the same.
 */
class UserTextTest {

    /**
     * The invisible and text-direction control characters that the design lists for removal, plus U+061C (the Arabic letter mark): the only
     * Bidi_Control character the design list missed, added at both sides at once.
     */
    private static final int[] INVISIBLE = {
        0x00AD, 0x061C, 0x200B, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2060, 0x2061, 0x2062, 0x2063,
        0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0xFEFF
    };

    private static String cp(int... codePoints) {
        return new String(codePoints, 0, codePoints.length);
    }

    // --- clean: comment content ------------------------------------------------------------------------

    @Test
    void CRLF_and_CR_both_become_LF() {
        assertThat(UserText.clean(IdentityViText.WORD_MOT + "\r\nhai\rba\r\n\r" + IdentityViText.WORD_BON))
                .isEqualTo(IdentityViText.WORD_MOT + "\nhai\nba\n\n" + IdentityViText.WORD_BON);
    }

    @Test
    void C0_and_C1_control_chars_are_removed_including_NUL_while_newline_and_tab_are_kept() {
        String raw = "a" + cp(0x00) + "b" + cp(0x07) + "c" + cp(0x1B) + "d" + cp(0x0B) + "e" + cp(0x0C) + "f" + cp(0x7F)
                + "g" + cp(0x85) + "h" + cp(0x9F) + "i\tj\nk";

        assertThat(UserText.clean(raw)).isEqualTo("abcdefghi\tj\nk");
    }

    @Test
    void invisible_and_text_direction_control_chars_are_removed() {
        for (int c : INVISIBLE) {
            assertThat(UserText.clean("a" + cp(c) + "b")).as("U+%04X", c).isEqualTo("ab");
        }
        // The classic spoofing trick: U+202E reverses the rest of the line.
        assertThat(UserText.clean(IdentityViText.SEE_PICTURE + cp(0x202E) + "gpj.exe"))
                .isEqualTo(IdentityViText.SEE_PICTURE + "gpj.exe");
    }

    @Test
    void ZWJ_and_ZWNJ_are_kept_because_emoji_sequences_and_some_scripts_need_them() {
        String family = cp(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467);
        assertThat(UserText.clean(family)).isEqualTo(family);
        String joinerFree = "a" + cp(0x200C) + "b";
        assertThat(UserText.clean(joinerFree)).isEqualTo(joinerFree);
    }

    @Test
    void trims_both_ends_including_what_is_exposed_after_removing_invisible_chars() {
        assertThat(UserText.clean(cp(0xFEFF) + "  \n " + IdentityViText.CONTENT + " \t\n" + cp(0x200B)))
                .isEqualTo(IdentityViText.CONTENT);
        assertThat(UserText.clean(cp(0x200B, 0x200B))).isEmpty();
    }

    @Test
    void three_or_more_consecutive_newlines_collapse_to_two() {
        assertThat(UserText.clean("a\n\n\n\n\nb\n\nc\n\n\nd")).isEqualTo("a\n\nb\n\nc\n\nd");
        // A line with only invisible characters becomes an empty line before collapsing.
        assertThat(UserText.clean("a\n" + cp(0x200B) + "\n\nb")).isEqualTo("a\n\nb");
    }

    @Test
    void indentation_and_inner_whitespace_are_kept_as_the_writer_pasted_them() {
        String code =
                IdentityViText.FOR_EXAMPLE + "\n    if (x) {\n        y();\n    }\n\n  " + IdentityViText.THAT_IS_ALL;

        assertThat(UserText.clean(code)).isEqualTo(code);
    }

    @Test
    void non_BMP_chars_and_HTML_are_kept_verbatim() {
        String raw = cp(0x1F600) + " <script>alert(1)</script> <img src=x onerror=alert(1)> " + cp(0x1D11E);

        assertThat(UserText.clean(raw)).isEqualTo(raw);
    }

    @Test
    void null_becomes_empty_string() {
        assertThat(UserText.clean(null)).isEmpty();
        assertThat(UserText.cleanName(null)).isEmpty();
    }

    // --- cleanName: display name -----------------------------------------------------------------------

    @Test
    void name_collapses_all_whitespace_including_newline_tab_and_nbsp_into_one_space() {
        assertThat(UserText.cleanName(
                        "  " + IdentityViText.NAME_NGUYEN + " \t " + IdentityViText.NAME_VAN + "\n\nAn  "))
                .isEqualTo(IdentityViText.NAME_NGUYEN + " " + IdentityViText.NAME_VAN + " An");
        assertThat(UserText.cleanName("A" + cp(0x00A0) + cp(0x3000) + "B" + cp(0x2028) + "C"))
                .isEqualTo("A B C");
    }

    @Test
    void name_removes_control_and_invisible_chars_without_inserting_whitespace_there() {
        for (int c : INVISIBLE) {
            assertThat(UserText.cleanName("Ali" + cp(c) + "ce")).as("U+%04X", c).isEqualTo("Alice");
        }
        assertThat(UserText.cleanName("Bob" + cp(0x00) + cp(0x85) + cp(0x7F) + "by"))
                .isEqualTo("Bobby");
    }

    @Test
    void name_of_only_invisible_chars_and_whitespace_becomes_empty_so_caller_uses_login() {
        assertThat(UserText.cleanName(cp(0x200B, 0x202E, 0xFEFF) + " \t\n " + cp(0x2066)))
                .isEmpty();
    }

    @Test
    void name_keeps_emoji_ZWJ_and_vietnamese_diacritics() {
        String name = IdentityViText.NAME_LE_THI_ANH + cp(0x1F469, 0x200D, 0x1F4BB);

        assertThat(UserText.cleanName(name)).isEqualTo(name);
    }

    // --- forLog: text that reaches a log line ----------------------------------------------------------

    @Test
    void log_text_has_no_line_break_or_other_control_character() {
        String forged = "Tag 'a\r\nINJECTED' already exists";

        assertThat(UserText.forLog(forged))
                .doesNotContain("\r")
                .doesNotContain("\n")
                .contains("INJECTED");
        for (int c : new int[] {0x00, 0x07, 0x1B, 0x7F, 0x85, 0x9F, 0x2028, 0x2029}) {
            assertThat(UserText.forLog("a" + cp(c) + "b")).as("U+%04X", c).isEqualTo("a" + cp(0xFFFD) + "b");
        }
    }

    @Test
    void log_text_also_replaces_text_direction_controls_and_keeps_ordinary_text() {
        for (int c : INVISIBLE) {
            assertThat(UserText.forLog("a" + cp(c) + "b")).as("U+%04X", c).isEqualTo("a" + cp(0xFFFD) + "b");
        }
        String ordinary = "Tag 'Spring Boot' already exists " + cp(0x1F600);
        assertThat(UserText.forLog(ordinary)).isEqualTo(ordinary);
    }

    @Test
    void log_text_is_cut_at_a_bounded_length_and_null_is_a_dash() {
        String longText = "x".repeat(5_000);

        assertThat(UserText.forLog(longText).length()).isLessThanOrEqualTo(UserText.LOG_TEXT_MAX + 1);
        assertThat(UserText.forLog(longText)).endsWith(cp(0x2026));
        assertThat(UserText.forLog(null)).isEqualTo("-");
    }
}
