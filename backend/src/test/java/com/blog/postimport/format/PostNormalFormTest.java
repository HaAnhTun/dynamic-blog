package com.blog.postimport.format;

import static org.assertj.core.api.Assertions.assertThat;

import java.text.Normalizer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** The normal form of a post file value: the form the download writes and the form values are compared in. No Spring. */
class PostNormalFormTest {

    private static final String EM_DASH = String.valueOf((char) 0x2014);
    private static final String NBSP = String.valueOf((char) 0x00A0);

    @Test
    void a_null_value_is_the_empty_string_in_every_form() {
        assertThat(PostNormalForm.line(null)).isEmpty();
        assertThat(PostNormalForm.tag(null)).isEmpty();
        assertThat(PostNormalForm.content(null)).isEmpty();
    }

    @Test
    void a_line_is_trimmed_with_the_javascript_whitespace_set() {
        String spaces = NBSP + (char) 0xFEFF + (char) 0x3000 + (char) 0x2003 + " \t";

        assertThat(PostNormalForm.line(spaces + "Title" + spaces)).isEqualTo("Title");
        // A zero width space is not white space in JavaScript, so it stays.
        String zeroWidth = String.valueOf((char) 0x200B);
        assertThat(PostNormalForm.line(zeroWidth + "x")).isEqualTo(zeroWidth + "x");
    }

    @Test
    void a_line_is_nfc() {
        String decomposed = "Cafe" + (char) 0x0301;

        assertThat(PostNormalForm.line(decomposed)).isEqualTo(Normalizer.normalize(decomposed, Normalizer.Form.NFC));
        assertThat(PostNormalForm.line(decomposed)).hasSize(4);
    }

    @ParameterizedTest
    @ValueSource(ints = {0x0A, 0x0D, 0x0B, 0x0C, 0x1C, 0x1D, 0x1E, 0x85, 0x2028, 0x2029})
    void every_line_break_the_developer_script_splits_at_becomes_a_space(int codePoint) {
        String brk = new String(Character.toChars(codePoint));

        assertThat(PostNormalForm.line("one" + brk + "two")).isEqualTo("one two");
        assertThat(PostNormalForm.line("one" + brk + brk + brk + "two")).isEqualTo("one two");
    }

    @Test
    void a_run_of_line_breaks_with_the_blanks_around_it_is_one_space() {
        assertThat(PostNormalForm.line("a\r\nb")).isEqualTo("a b");
        assertThat(PostNormalForm.line("a \t\n\r\n \tb")).isEqualTo("a b");
        assertThat(PostNormalForm.line("Sentence one.\n\nSentence two.\r\nSentence three."))
                .isEqualTo("Sentence one. Sentence two. Sentence three.");
    }

    @Test
    void spaces_that_touch_no_line_break_are_kept() {
        assertThat(PostNormalForm.line("a  b")).isEqualTo("a  b");
    }

    @Test
    void a_blank_line_between_two_breaks_gives_two_spaces_like_the_typescript_writer() {
        // The writer's regular expression takes the spaces after the first break before it sees the second one.
        assertThat(PostNormalForm.line("a \n \nb")).isEqualTo("a  b");
    }

    @Test
    void three_or_more_hyphens_become_one_em_dash_and_two_stay() {
        assertThat(PostNormalForm.line("a--b")).isEqualTo("a--b");
        assertThat(PostNormalForm.line("a---b")).isEqualTo("a" + EM_DASH + "b");
        assertThat(PostNormalForm.line("a--------b")).isEqualTo("a" + EM_DASH + "b");
        assertThat(PostNormalForm.line("---")).isEqualTo(EM_DASH);
        assertThat(PostNormalForm.line("a-b-c")).isEqualTo("a-b-c");
    }

    @Test
    void a_line_combines_the_rules() {
        assertThat(PostNormalForm.line("  Before --- after\n\nmore  ")).isEqualTo("Before " + EM_DASH + " after more");
    }

    @Test
    void a_tag_has_no_comma_and_one_space_between_words() {
        assertThat(PostNormalForm.tag("Node.js, Deno")).isEqualTo("Node.js Deno");
        assertThat(PostNormalForm.tag("a,,b")).isEqualTo("a b");
        assertThat(PostNormalForm.tag(" a \n  b\t c ")).isEqualTo("a b c");
        assertThat(PostNormalForm.tag(",lead and trail,")).isEqualTo("lead and trail");
        assertThat(PostNormalForm.tag(",")).isEmpty();
        assertThat(PostNormalForm.tag("a---b")).isEqualTo("a" + EM_DASH + "b");
        assertThat(PostNormalForm.tag("a" + NBSP + NBSP + "b")).isEqualTo("a b");
    }

    @Test
    void content_drops_leading_blank_lines_and_trailing_line_breaks_only() {
        assertThat(PostNormalForm.content("\n\n  \t\nbody\nmore\n\n\n")).isEqualTo("body\nmore");
        assertThat(PostNormalForm.content("    indented code\n")).isEqualTo("    indented code");
        assertThat(PostNormalForm.content("trailing spaces  \n")).isEqualTo("trailing spaces  ");
        assertThat(PostNormalForm.content("Para one.\n\n\nPara two.")).isEqualTo("Para one.\n\n\nPara two.");
    }

    @Test
    void content_with_and_without_a_final_newline_is_equal() {
        assertThat(PostNormalForm.content("text")).isEqualTo(PostNormalForm.content("text\n"));
    }

    @Test
    void content_has_lf_line_endings_and_is_nfc() {
        assertThat(PostNormalForm.content("a\r\nb\rc")).isEqualTo("a\nb\nc");
        assertThat(PostNormalForm.content("Cafe" + (char) 0x0301)).isEqualTo("Caf" + (char) 0x00E9);
    }

    @Test
    void content_of_only_blank_lines_is_empty() {
        assertThat(PostNormalForm.content("\n  \n\t\n")).isEmpty();
        assertThat(PostNormalForm.content("")).isEmpty();
    }

    @Test
    void strip_trims_both_ends_and_keeps_the_inside() {
        assertThat(PostNormalForm.strip(" \t a b \n")).isEqualTo("a b");
        assertThat(PostNormalForm.strip("")).isEmpty();
        assertThat(PostNormalForm.strip(" \n ")).isEmpty();
    }
}
