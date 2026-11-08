package com.blog.auth.mfa;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import org.junit.jupiter.api.Test;

/** The base32 text and the authenticator link of a TOTP secret, over the BouncyCastle encoder the project already has. */
class MfaSecretsTest {

    private static byte[] ascii(String text) {
        return text.getBytes(StandardCharsets.US_ASCII);
    }

    @Test
    void rfc_4648_base32_test_vectors_encode_and_decode() {
        String[][] vectors = {
            {"f", "MY======"},
            {"fo", "MZXQ===="},
            {"foo", "MZXW6==="},
            {"foob", "MZXW6YQ="},
            {"fooba", "MZXW6YTB"},
            {"foobar", "MZXW6YTBOI======"}
        };
        for (String[] vector : vectors) {
            assertThat(MfaSecrets.encode(ascii(vector[0]))).as(vector[0]).isEqualTo(vector[1]);
            assertThat(MfaSecrets.decode(vector[1])).as(vector[1]).hasValue(ascii(vector[0]));
        }
    }

    @Test
    void a_secret_of_twenty_bytes_is_thirty_two_characters_without_padding_and_round_trips() {
        byte[] secret = MfaSecrets.generate(new SecureRandom());

        String text = MfaSecrets.encode(secret);

        assertThat(secret).hasSize(MfaSecrets.SECRET_BYTES);
        assertThat(text).hasSize(32).matches("[A-Z2-7]{32}");
        assertThat(MfaSecrets.decode(text)).hasValue(secret);
    }

    @Test
    void two_generated_secrets_differ() {
        SecureRandom random = new SecureRandom();
        assertThat(MfaSecrets.generate(random)).isNotEqualTo(MfaSecrets.generate(random));
    }

    @Test
    void decoding_forgives_spaces_hyphens_padding_and_lower_case() {
        byte[] expected = ascii("foobar");

        assertThat(MfaSecrets.decode("mzxw 6ytb-oi")).hasValue(expected);
        assertThat(MfaSecrets.decode("MZXW6YTBOI")).hasValue(expected);
        assertThat(MfaSecrets.decode("  MZXW6YTBOI======  ")).hasValue(expected);
    }

    @Test
    void decoding_rejects_characters_outside_the_alphabet_and_impossible_lengths() {
        for (String bad : new String[] {null, "", "   ", "MZXW6YT!OI", "0189", "MZXW6YTBO", "A"}) {
            assertThat(MfaSecrets.decode(bad)).as("input '%s'", bad).isEmpty();
        }
    }

    @Test
    void the_text_shown_to_a_person_is_in_groups_of_four() {
        assertThat(MfaSecrets.group("ABCDEFGHIJ")).isEqualTo("ABCD EFGH IJ");
        assertThat(MfaSecrets.group("ABCDEFGH")).isEqualTo("ABCD EFGH");
        assertThat(MfaSecrets.group("")).isEmpty();
    }

    @Test
    void the_otpauth_link_has_fixed_parameters_and_percent_encoded_label_parts() {
        byte[] secret = ascii("12345678901234567890");

        String uri = MfaSecrets.otpauthUri("Blog", "owner@example.test", secret);

        assertThat(uri)
                .isEqualTo("otpauth://totp/Blog:owner%40example.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
                        + "&issuer=Blog&algorithm=SHA1&digits=6&period=30");
        assertThat(MfaSecrets.otpauthUri("My Site & Co", "a b", secret))
                .startsWith("otpauth://totp/My%20Site%20%26%20Co:a%20b?secret=")
                .contains("&issuer=My%20Site%20%26%20Co&");
    }
}
