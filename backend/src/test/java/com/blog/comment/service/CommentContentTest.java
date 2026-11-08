package com.blog.comment.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

/**
 * Comment content: sanitized with UserText.clean, then requires 2-2000 code points
 * and at least one visible character. The detailed sanitizing is in UserTextTest; here is what CommentContent
 * adds and what it returns to the saving service.
 *
 * Special characters are built from code points ({@link #cp}), as in UserTextTest: invisible characters
 * written straight into the source cannot be read by anyone.
 */
class CommentContentTest {

    private static String cp(int... codePoints) {
        return new String(codePoints, 0, codePoints.length);
    }

    private static void assertRejected(String raw) {
        assertThatThrownBy(() -> CommentContent.normalize(raw)).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(ErrorCode.VALIDATION_ERROR);
            assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
            // Fixed message: never copies the content of the writer into the error message or the
            // log.
            assertThat(e.getMessage()).isEqualTo("Comment must be 2–2000 characters");
        });
    }

    @Test
    void returns_exactly_the_sanitized_string_to_store() {
        assertThat(CommentContent.normalize("  one\r\ntwo\rthree  ")).isEqualTo("one\ntwo\nthree");
        assertThat(CommentContent.normalize("ok")).isEqualTo("ok");
    }

    @Test
    void nul_and_control_characters_are_dropped_before_counting() {
        assertThat(CommentContent.normalize("a" + cp(0x00) + "b" + cp(0x1B) + cp(0x85)))
                .isEqualTo("ab");
        // Only one character left after dropping: under the minimum, even though the submitted string is
        // three long.
        assertRejected("a" + cp(0x00) + cp(0x07));
    }

    @Test
    void only_invisible_characters_or_whitespace_is_rejected() {
        assertRejected(cp(0x200B, 0x200B));
        assertRejected("   \n\t  ");
        assertRejected(cp(0xFEFF, 0x202E, 0x2066));
        assertRejected("");
        assertRejected(null);
    }

    @Test
    void only_nonbreaking_spaces_is_rejected_even_though_strip_does_not_trim_them() {
        // U+00A0, U+2007, U+202F: Character.isWhitespace returns false, so strip() leaves them and the string
        // stays two, three long. They are still whitespace (Character.isSpaceChar), not visible characters.
        assertRejected(cp(0x00A0, 0x00A0));
        assertRejected(cp(0x2007, 0x202F));
        assertRejected(cp(0x00A0) + " " + cp(0x202F) + "\n" + cp(0x200D));
        // Next to a letter it is still saved verbatim, like any inner whitespace.
        assertThat(CommentContent.normalize("a" + cp(0x00A0) + "b")).isEqualTo("a" + cp(0x00A0) + "b");
        assertThat(CommentContent.normalize(cp(0x00A0) + "ok")).isEqualTo(cp(0x00A0) + "ok");
    }

    @Test
    void arabic_letter_mark_u061c_is_dropped_like_every_bidi_control_character() {
        assertThat(CommentContent.normalize("a" + cp(0x061C) + "b")).isEqualTo("ab");
        assertRejected(cp(0x061C, 0x061C, 0x061C));
    }

    @Test
    void zwj_and_zwnj_are_kept_but_alone_they_are_not_visible_characters() {
        // UserText.clean keeps U+200C, U+200D, so the string stays two long: it is the "has a visible
        // character" rule (not whitespace, not Character.FORMAT) that blocks it.
        assertRejected(cp(0x200D, 0x200D));
        assertRejected(cp(0x200C) + " " + cp(0x200D));
    }

    @Test
    void bidi_control_characters_are_dropped_from_stored_content() {
        assertThat(CommentContent.normalize("view photo" + cp(0x202E) + "gpj.exe"))
                .isEqualTo("view photogpj.exe");
        assertThat(CommentContent.normalize(cp(0x2067) + "text" + cp(0x2069))).isEqualTo("text");
    }

    @Test
    void zwj_joined_emoji_is_kept_intact() {
        String family = cp(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467);

        assertThat(CommentContent.normalize(family)).isEqualTo(family);
    }

    @Test
    void length_is_counted_in_code_points_from_2_to_2000() {
        assertRejected("a");
        assertThat(CommentContent.normalize("ab")).isEqualTo("ab");
        assertThat(CommentContent.normalize("a".repeat(2000))).hasSize(2000);
        assertRejected("a".repeat(2001));

        // An emoji outside the BMP is two chars in Java but one character to the writer and to the DB CHECK
        // on char_length.
        String emoji2000 = cp(0x1F600).repeat(2000);
        assertThat(CommentContent.normalize(emoji2000)).isEqualTo(emoji2000);
        assertRejected(cp(0x1F600).repeat(2001));
        assertThat(CommentContent.normalize(cp(0x1F600, 0x1F600))).isEqualTo(cp(0x1F600, 0x1F600));
    }

    @Test
    void length_is_measured_after_sanitizing_not_on_the_submitted_string() {
        // 2000 characters plus whitespace and invisible characters at both ends: exactly 2000 after
        // sanitizing.
        String padded = "  " + cp(0x200B) + "a".repeat(2000) + "\n\n" + cp(0xFEFF);
        assertThat(CommentContent.normalize(padded)).hasSize(2000);
        // One letter between two stretches of whitespace: one character left.
        assertRejected("   a   ");
        assertThat(CommentContent.normalize(" a b ")).isEqualTo("a b");
    }

    @Test
    void html_is_kept_verbatim_because_it_is_only_ever_displayed_as_text() {
        String payload = "<script>alert(1)</script> <img src=x onerror=alert(1)>";

        assertThat(CommentContent.normalize(payload)).isEqualTo(payload);
    }
}
