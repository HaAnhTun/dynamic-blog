package com.blog.auth.mfa;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.auth.mfa.RecoveryCodes.Shape;
import java.security.SecureRandom;
import java.util.HashSet;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Recovery codes: 120 bits, a plain SHA-256 at rest, forgiving input, and the shape that tells them from a TOTP code. */
class RecoveryCodesTest {

    private static final String SAMPLE = "ABCD1234EFGH5678JKMN9PQR";

    @Test
    void a_code_is_twenty_four_characters_of_the_thirty_two_symbol_alphabet() {
        assertThat(RecoveryCodes.ALPHABET).hasSize(32).doesNotContain("I", "L", "O", "U");
        List<String> codes = RecoveryCodes.generate(new SecureRandom());
        for (String code : codes) {
            assertThat(code).hasSize(RecoveryCodes.LENGTH).matches("[0-9A-HJKMNP-TV-Z]{24}");
        }
    }

    @Test
    void the_entropy_stays_at_or_above_the_asvs_threshold_for_a_plain_hash() {
        // ASVS 5.0 6.5.2: a standard hash function is acceptable for a lookup secret of at least 112 bits.
        assertThat(RecoveryCodes.ENTROPY_BITS).isEqualTo(120).isGreaterThanOrEqualTo(112);
        assertThat(Math.log(RecoveryCodes.ALPHABET.length()) / Math.log(2) * RecoveryCodes.LENGTH)
                .isGreaterThanOrEqualTo(112);
    }

    @Test
    void ten_codes_are_generated_and_all_differ() {
        List<String> codes = RecoveryCodes.generate(new SecureRandom());

        assertThat(codes).hasSize(RecoveryCodes.COUNT).doesNotHaveDuplicates();
        assertThat(new HashSet<>(RecoveryCodes.generate(new SecureRandom()))).doesNotContainAnyElementsOf(codes);
    }

    @Test
    void a_code_is_shown_in_six_groups_of_four() {
        assertThat(RecoveryCodes.format(SAMPLE)).isEqualTo("ABCD-1234-EFGH-5678-JKMN-9PQR");
    }

    @Test
    void input_is_normalised_for_case_spaces_hyphens_and_the_confusable_letters() {
        assertThat(RecoveryCodes.normalise("abcd-1234-efgh-5678-jkmn-9pqr")).isEqualTo(SAMPLE);
        assertThat(RecoveryCodes.normalise(" ABCD 1234 EFGH 5678 JKMN 9PQR ")).isEqualTo(SAMPLE);
        // I and L are read as 1, O as 0.
        assertThat(RecoveryCodes.normalise("ABCD-I234-EFGH-5678-JKMN-9PQR")).isEqualTo(SAMPLE);
        assertThat(RecoveryCodes.normalise("ABCD-l234-EFGH-5678-JKMN-9PQR")).isEqualTo(SAMPLE);
        assertThat(RecoveryCodes.normalise("OOOO-OOOO-OOOO-OOOO-OOOO-OOOO")).isEqualTo("0".repeat(24));
    }

    @Test
    void input_that_is_not_a_code_normalises_to_null() {
        for (String bad : new String[] {
            null, "", "ABCD", SAMPLE + "A", SAMPLE.substring(1), "ABCD1234EFGH5678JKMNU9PQ", "!".repeat(24)
        }) {
            assertThat(RecoveryCodes.normalise(bad)).as("input '%s'", bad).isNull();
        }
    }

    @Test
    void the_stored_hash_is_the_sha256_hex_of_the_normalised_code() {
        // SHA-256 of the 24 characters; the value is fixed so a change of the algorithm or of the input is noticed.
        assertThat(RecoveryCodes.hash(SAMPLE)).hasSize(64).matches("[0-9a-f]{64}");
        assertThat(RecoveryCodes.hash(SAMPLE)).isEqualTo(RecoveryCodes.hash(SAMPLE));
        assertThat(RecoveryCodes.hash(SAMPLE)).isNotEqualTo(RecoveryCodes.hash(SAMPLE.replace('A', 'B')));
        assertThat(RecoveryCodes.hash("abc"))
                .isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    @Test
    void shape_tells_a_six_digit_code_from_a_recovery_code_from_anything_else() {
        assertThat(RecoveryCodes.shapeOf("123456")).isEqualTo(Shape.TOTP);
        assertThat(RecoveryCodes.shapeOf(" 123 456 ")).isEqualTo(Shape.TOTP);
        assertThat(RecoveryCodes.shapeOf("123456\n")).isEqualTo(Shape.TOTP);
        assertThat(RecoveryCodes.shapeOf(RecoveryCodes.format(SAMPLE))).isEqualTo(Shape.RECOVERY);
        assertThat(RecoveryCodes.shapeOf(SAMPLE.toLowerCase(java.util.Locale.ROOT)))
                .isEqualTo(Shape.RECOVERY);
        for (String other : new String[] {null, "", "12345", "1234567", "12345a", "ABCD-EFGH", SAMPLE + "x"}) {
            assertThat(RecoveryCodes.shapeOf(other)).as("input '%s'", other).isEqualTo(Shape.INVALID);
        }
    }

    @Test
    void totp_digits_extracts_exactly_six_ascii_digits() {
        assertThat(RecoveryCodes.totpDigits("012 345")).isEqualTo("012345");
        assertThat(RecoveryCodes.totpDigits("01234")).isNull();
        assertThat(RecoveryCodes.totpDigits("0123456")).isNull();
        assertThat(RecoveryCodes.totpDigits("01234x")).isNull();
        assertThat(RecoveryCodes.totpDigits(null)).isNull();
    }
}
