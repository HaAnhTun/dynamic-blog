package com.blog.postimport.format;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.Arrays;
import java.util.HexFormat;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.function.Executable;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpStatus;

/** Decoding of an uploaded post file: size, encoding, characters and line endings, and no cap on a line. No Spring. */
class PostFileTest {

    private static final String SECRET = "QQSECRETQQ";
    private static final String BOM = String.valueOf((char) 0xFEFF);

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static void assertRejected(Executable call, ErrorCode code, HttpStatus status) {
        assertThatThrownBy(call::execute).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(code);
            assertThat(e.getStatus()).isEqualTo(status);
            assertThat(e.getMessage()).doesNotContain(SECRET);
        });
    }

    private static void assertInvalidFile(byte[] bytes) {
        assertRejected(() -> PostFile.decode(bytes), ErrorCode.POST_IMPORT_INVALID_FILE, HttpStatus.BAD_REQUEST);
    }

    @Test
    void plain_text_is_returned_as_is() {
        assertThat(PostFile.decode(utf8("---\ntitle: A\n---\n\nBody\n"))).isEqualTo("---\ntitle: A\n---\n\nBody\n");
    }

    @Test
    void tabs_are_allowed() {
        assertThat(PostFile.decode(utf8("a\tb\n"))).isEqualTo("a\tb\n");
    }

    @Test
    void one_byte_order_mark_is_removed() {
        assertThat(PostFile.decode(utf8(BOM + "---\n"))).isEqualTo("---\n");
        assertThat(PostFile.decode(utf8(BOM + BOM + "x"))).isEqualTo(BOM + "x");
    }

    @Test
    void crlf_and_cr_become_lf() {
        assertThat(PostFile.decode(utf8("a\r\nb\rc\n\r\nd"))).isEqualTo("a\nb\nc\n\nd");
    }

    @Test
    void text_is_normalized_to_nfc() {
        String composed = "Cafe" + (char) 0x00E9;
        String decomposed = Normalizer.normalize(composed, Normalizer.Form.NFD);
        assertThat(decomposed).isNotEqualTo(composed);
        assertThat(PostFile.decode(utf8(decomposed))).isEqualTo(composed);
    }

    @ParameterizedTest
    @NullAndEmptySource
    void an_empty_file_is_rejected(byte[] bytes) {
        assertInvalidFile(bytes);
    }

    @Test
    void a_file_with_only_a_byte_order_mark_is_rejected() {
        assertInvalidFile(new byte[] {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF});
    }

    @Test
    void the_size_limit_is_256_kib() {
        assertThat(PostFile.MAX_BYTES).isEqualTo(256 * 1024);
    }

    @Test
    void a_file_over_the_size_limit_is_rejected_with_413() {
        byte[] bytes = new byte[PostFile.MAX_BYTES + 1];
        Arrays.fill(bytes, (byte) '\n');
        assertRejected(() -> PostFile.decode(bytes), ErrorCode.VALIDATION_ERROR, HttpStatus.CONTENT_TOO_LARGE);
    }

    @Test
    void a_file_of_exactly_the_size_limit_is_accepted() {
        byte[] bytes = new byte[PostFile.MAX_BYTES];
        Arrays.fill(bytes, (byte) '\n');
        assertThat(PostFile.decode(bytes)).hasSize(PostFile.MAX_BYTES);
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "C3", // truncated two-byte sequence
                "FF", // never valid
                "C0AF", // overlong encoding of '/'
                "EDA080", // encoded surrogate
                "F09F98", // truncated four-byte sequence
                "F4908080" // above U+10FFFF
            })
    void invalid_utf8_is_rejected_without_echoing_the_file(String hex) {
        byte[] bad = HexFormat.of().parseHex(hex);
        byte[] prefix = utf8("title: " + SECRET + "\n");
        byte[] bytes = Arrays.copyOf(prefix, prefix.length + bad.length);
        System.arraycopy(bad, 0, bytes, prefix.length, bad.length);
        assertInvalidFile(bytes);
    }

    @ParameterizedTest
    @ValueSource(ints = {0x00, 0x01, 0x07, 0x08, 0x0B, 0x0C, 0x1B, 0x1F, 0x7F, 0x85, 0x9F})
    void control_characters_are_rejected_with_the_line_number(int codePoint) {
        String text = "line one " + SECRET + "\nline two\nthree " + (char) codePoint + " " + SECRET + "\n";
        assertThatThrownBy(() -> PostFile.decode(utf8(text))).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(ErrorCode.POST_IMPORT_INVALID_FILE);
            assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(e.getMessage()).contains("line 3").doesNotContain(SECRET);
        });
    }

    @Test
    void the_control_character_line_number_counts_crlf_and_cr_lines() {
        String text = "a\r\nb\rc\r\nd" + (char) 0x01 + "\n";
        assertThatThrownBy(() -> PostFile.decode(utf8(text)))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getMessage()).contains("line 4"));
    }

    @Test
    void a_very_long_line_is_accepted_because_a_body_has_no_line_cap() {
        String line = "word ".repeat(50_000);
        assertThat(line.length()).isGreaterThan(200_000);
        assertThat(PostFile.decode(utf8("x\n" + line + "\ny"))).contains(line);
    }

    @Test
    void sha256_is_lower_case_hex_of_the_raw_bytes() {
        assertThat(PostFile.sha256Hex(utf8("abc")))
                .isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assertThat(PostFile.sha256Hex(utf8(BOM + "abc"))).isNotEqualTo(PostFile.sha256Hex(utf8("abc")));
    }

    @ParameterizedTest
    @ValueSource(strings = {"post.md", "POST.MD", "my-post.Md", "C:\\Users\\x\\post.md", "dir/sub/p.md"})
    void markdown_names_are_accepted(String name) {
        assertThatCode(() -> PostFile.requireMarkdownName(name)).doesNotThrowAnyException();
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"post.txt", "post.markdown", "post.md.exe", "post.md/", "x.md\\evil.sh", "md"})
    void other_names_are_rejected(String name) {
        assertRejected(
                () -> PostFile.requireMarkdownName(name), ErrorCode.POST_IMPORT_INVALID_FILE, HttpStatus.BAD_REQUEST);
    }
}
