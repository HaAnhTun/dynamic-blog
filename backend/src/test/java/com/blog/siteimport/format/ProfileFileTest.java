package com.blog.siteimport.format;

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

/** Decoding of an uploaded profile file: size, encoding, characters, line endings and line length. No Spring. */
class ProfileFileTest {

    private static final String SECRET = "QQSECRETQQ";

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
        assertRejected(() -> ProfileFile.decode(bytes), ErrorCode.SITE_IMPORT_INVALID_FILE, HttpStatus.BAD_REQUEST);
    }

    @Test
    void plain_text_is_returned_as_is() {
        assertThat(ProfileFile.decode(utf8("# Site\n- name: A\n"))).isEqualTo("# Site\n- name: A\n");
    }

    @Test
    void tabs_are_allowed() {
        assertThat(ProfileFile.decode(utf8("a\tb\n"))).isEqualTo("a\tb\n");
    }

    @Test
    void one_byte_order_mark_is_removed() {
        String bom = String.valueOf((char) 0xFEFF);
        assertThat(ProfileFile.decode(utf8(bom + "# Site\n"))).isEqualTo("# Site\n");
        assertThat(ProfileFile.decode(utf8(bom + bom + "x"))).isEqualTo(bom + "x");
    }

    @Test
    void crlf_and_cr_become_lf() {
        assertThat(ProfileFile.decode(utf8("a\r\nb\rc\n\r\nd"))).isEqualTo("a\nb\nc\n\nd");
    }

    @Test
    void text_is_normalized_to_nfc() {
        String composed = ProfileMarkdownParserTest.u("Vi{1EC7}t");
        String decomposed = Normalizer.normalize(composed, Normalizer.Form.NFD);
        assertThat(decomposed).isNotEqualTo(composed);
        assertThat(ProfileFile.decode(utf8(decomposed))).isEqualTo(composed);
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
    void a_file_over_the_size_limit_is_rejected_with_413() {
        byte[] bytes = new byte[ProfileFile.MAX_BYTES + 1];
        Arrays.fill(bytes, (byte) '\n');
        assertRejected(() -> ProfileFile.decode(bytes), ErrorCode.VALIDATION_ERROR, HttpStatus.CONTENT_TOO_LARGE);
    }

    @Test
    void a_file_of_exactly_the_size_limit_is_accepted() {
        byte[] bytes = new byte[ProfileFile.MAX_BYTES];
        Arrays.fill(bytes, (byte) '\n');
        assertThat(ProfileFile.decode(bytes)).hasSize(ProfileFile.MAX_BYTES);
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
    void invalid_utf8_is_rejected(String hex) {
        byte[] bad = HexFormat.of().parseHex(hex);
        byte[] prefix = utf8("# Site " + SECRET + "\n");
        byte[] bytes = Arrays.copyOf(prefix, prefix.length + bad.length);
        System.arraycopy(bad, 0, bytes, prefix.length, bad.length);
        assertInvalidFile(bytes);
    }

    @ParameterizedTest
    @ValueSource(ints = {0x00, 0x01, 0x07, 0x08, 0x0B, 0x0C, 0x1B, 0x1F, 0x7F, 0x85, 0x9F})
    void control_characters_are_rejected_with_the_line_number(int codePoint) {
        String text = "line one " + SECRET + "\nline two\nthree " + (char) codePoint + " " + SECRET + "\n";
        assertThatThrownBy(() -> ProfileFile.decode(utf8(text))).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(ErrorCode.SITE_IMPORT_INVALID_FILE);
            assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(e.getMessage()).contains("line 3").doesNotContain(SECRET);
        });
    }

    @Test
    void a_line_of_the_maximum_length_is_accepted() {
        String line = "a".repeat(ProfileFile.MAX_LINE_CHARS);
        assertThat(ProfileFile.decode(utf8("x\n" + line + "\ny"))).contains(line);
    }

    @Test
    void the_line_length_counts_characters_not_utf16_units() {
        String emoji = new String(Character.toChars(0x1F600));
        assertThat(ProfileFile.decode(utf8(emoji.repeat(ProfileFile.MAX_LINE_CHARS))))
                .hasSize(2 * ProfileFile.MAX_LINE_CHARS);
        assertThatThrownBy(() -> ProfileFile.decode(utf8(emoji.repeat(ProfileFile.MAX_LINE_CHARS + 1))))
                .isInstanceOf(ApiException.class);
    }

    @Test
    void a_longer_line_is_rejected_with_its_number_and_without_its_content() {
        String line = SECRET.repeat(ProfileFile.MAX_LINE_CHARS / SECRET.length() + 1);
        assertThatThrownBy(() -> ProfileFile.decode(utf8("x\r\ny\r\n" + line + "\r\n")))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.SITE_IMPORT_INVALID_FILE);
                    assertThat(e.getMessage()).contains("Line 3").doesNotContain(SECRET);
                });
    }

    @Test
    void the_line_length_is_counted_after_nfc_normalization() {
        String composed = ProfileMarkdownParserTest.u("{1EC7}").repeat(ProfileFile.MAX_LINE_CHARS);
        String decomposed = Normalizer.normalize(composed, Normalizer.Form.NFD);
        assertThat(decomposed.length()).isGreaterThan(ProfileFile.MAX_LINE_CHARS);
        assertThat(ProfileFile.decode(utf8(decomposed))).isEqualTo(composed);
    }

    @Test
    void sha256_is_lower_case_hex_of_the_raw_bytes() {
        assertThat(ProfileFile.sha256Hex(utf8("abc")))
                .isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        byte[] withBom = utf8((char) 0xFEFF + "abc");
        assertThat(ProfileFile.sha256Hex(withBom)).isNotEqualTo(ProfileFile.sha256Hex(utf8("abc")));
    }

    @ParameterizedTest
    @ValueSource(
            strings = {"profile.md", "PROFILE.MD", "site-profile-vi.Md", "C:\\Users\\x\\profile.md", "dir/sub/p.md"})
    void markdown_names_are_accepted(String name) {
        assertThatCode(() -> ProfileFile.requireMarkdownName(name)).doesNotThrowAnyException();
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"profile.txt", "profile.markdown", "profile.md.exe", "profile.md/", "x.md\\evil.sh", "md"})
    void other_names_are_rejected(String name) {
        assertRejected(
                () -> ProfileFile.requireMarkdownName(name),
                ErrorCode.SITE_IMPORT_INVALID_FILE,
                HttpStatus.BAD_REQUEST);
    }
}
