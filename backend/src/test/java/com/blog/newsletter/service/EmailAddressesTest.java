package com.blog.newsletter.service;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;

/** Normalizing newsletter addresses: one address, one stored form, so the UNIQUE key and the blocking row cannot be bypassed. */
class EmailAddressesTest {

    @Test
    void trims_surrounding_whitespace_and_lowercases_the_whole_address() {
        assertThat(EmailAddresses.normalize("  Alice.Nguyen@Example.COM \t\n")).contains("alice.nguyen@example.com");
        // Unicode whitespace (U+3000, U+2003) also counts as surrounding whitespace.
        assertThat(EmailAddresses.normalize((char) 0x3000 + "bob@example.com" + (char) 0x2003))
                .contains("bob@example.com");
    }

    @Test
    void an_rfc_2047_encoded_word_in_the_local_part_is_rejected_but_the_characters_alone_are_not() {
        // "=?" starts an encoded word, which a mail client decodes into something else than the address it was given.
        assertThat(EmailAddresses.normalize("=?utf-8?q?x?=@example.com")).isEmpty();
        assertThat(EmailAddresses.normalize("a.=?b@example.com")).isEmpty();
        assertThat(EmailAddresses.normalize("a=b@example.com")).contains("a=b@example.com");
        assertThat(EmailAddresses.normalize("a?b@example.com")).contains("a?b@example.com");
        assertThat(EmailAddresses.normalize("a+tag@example.com")).contains("a+tag@example.com");
    }

    @Test
    void plus_part_is_kept_so_it_is_a_different_address() {
        assertThat(EmailAddresses.normalize("alice+news@example.com")).contains("alice+news@example.com");
        assertThat(EmailAddresses.normalize("alice+news@example.com"))
                .isNotEqualTo(EmailAddresses.normalize("alice@example.com"));
    }

    @Test
    void nfc_runs_before_the_ascii_check_so_equivalent_characters_normalize_to_one_form() {
        // KELVIN SIGN (U+212A) is canonically equivalent to K: NFC turns it into K, then into k.
        assertThat(EmailAddresses.normalize((char) 0x212A + "elvin@example.com"))
                .contains("kelvin@example.com");
    }

    @Test
    void non_ascii_address_is_rejected() {
        assertThat(EmailAddresses.normalize("ng" + (char) 0x01B0 + "oi@example.com"))
                .isEmpty();
        assertThat(EmailAddresses.normalize("user@b" + (char) 0x00FC + "cher.de"))
                .isEmpty();
        assertThat(EmailAddresses.normalize("user@example.com" + (char) 0xFEFF)).isEmpty();
    }

    @Test
    void control_character_in_the_middle_is_rejected() {
        assertThat(EmailAddresses.normalize("al" + (char) 0 + "ice@example.com"))
                .isEmpty();
        assertThat(EmailAddresses.normalize("alice@exa" + (char) 0x7F + "mple.com"))
                .isEmpty();
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(
            strings = {
                "   ",
                "alice",
                "alice@",
                "@example.com",
                "alice@localhost",
                "alice@example",
                "alice smith@example.com",
                "alice@exa mple.com",
                "alice@@example.com",
                "alice@b@example.com",
                ".alice@example.com",
                "alice.@example.com",
                "al..ice@example.com",
                "alice@-example.com",
                "alice@example-.com",
                "alice@example..com",
                "alice@.example.com",
                "alice@example.com.",
                "\"alice\"@example.com",
                "alice@[203.0.113.7]",
                "<alice@example.com>",
                "Alice <alice@example.com>",
                "alice@example.com, bob@example.com"
            })
    void malformed_form_is_rejected(String raw) {
        assertThat(EmailAddresses.normalize(raw)).as(String.valueOf(raw)).isEmpty();
    }

    @Test
    void at_most_64_characters_before_at_sign_and_254_for_the_whole_address() {
        String domain = "@" + "d".repeat(63) + "." + "e".repeat(63) + "." + "f".repeat(57) + ".com";
        assertThat(("a".repeat(64) + domain).length()).isEqualTo(254);
        assertThat(EmailAddresses.normalize("a".repeat(64) + domain)).isPresent();
        assertThat(EmailAddresses.normalize("a".repeat(65) + "@example.com")).isEmpty();
        assertThat(EmailAddresses.normalize("a".repeat(65) + domain)).isEmpty();
        // A domain label has at most 63 characters.
        assertThat(EmailAddresses.normalize("a@" + "d".repeat(64) + ".com")).isEmpty();
    }
}
