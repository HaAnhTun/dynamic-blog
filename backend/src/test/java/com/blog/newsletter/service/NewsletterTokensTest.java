package com.blog.newsletter.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Newsletter tokens and hashes: the confirmation token is a full 256 random bits and only its hash is stored; the
 * unsubscribe token is the id plus a MAC, which cannot be forged without the key; both have exactly the shape the BFF checks.
 */
class NewsletterTokensTest {

    private static final byte[] KEY = "khoa-newsletter-cua-test-dai-hon-32-byte".getBytes(StandardCharsets.UTF_8);
    private final NewsletterTokens tokens = new NewsletterTokens(KEY);

    @Test
    void confirmation_token_is_32_random_bytes_base64url_and_hash_is_sha_256_hex() {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 100; i++) {
            String token = NewsletterTokens.newConfirmationToken();
            assertThat(token).matches("[A-Za-z0-9_-]{43}");
            assertThat(Base64.getUrlDecoder().decode(token)).hasSize(32);
            assertThat(NewsletterTokens.wellFormed(token)).isTrue();
            seen.add(token);
        }
        assertThat(seen).hasSize(100);
        // The standard SHA-256 test vector.
        assertThat(NewsletterTokens.sha256Hex("abc"))
                .isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    @Test
    void unsubscribe_token_opens_to_the_right_id_and_has_the_shape_the_bff_accepts() {
        UUID id = UUID.randomUUID();
        String token = tokens.unsubscribeToken(id);

        assertThat(token).matches("[A-Za-z0-9_-]{20,200}");
        assertThat(tokens.unsubscribeId(token)).contains(id);
        // Deterministic: the link in every mail to the same person is the same.
        assertThat(tokens.unsubscribeToken(id)).isEqualTo(token);
    }

    @Test
    void tampered_or_differently_keyed_or_malformed_unsubscribe_token_is_rejected() {
        UUID id = UUID.randomUUID();
        String token = tokens.unsubscribeToken(id);

        // Change one character in the MAC part, then in the id part: the MAC no longer matches.
        assertThat(tokens.unsubscribeId(flip(token, token.length() - 3))).isEmpty();
        assertThat(tokens.unsubscribeId(flip(token, 2))).isEmpty();
        // Combine another person's id with this person's MAC.
        String other = tokens.unsubscribeToken(UUID.randomUUID());
        assertThat(tokens.unsubscribeId(other.substring(0, 21) + token.substring(21)))
                .isEmpty();
        // Same id, different key.
        NewsletterTokens otherKey = new NewsletterTokens("mot-khoa-khac-hoan-toan-dai-hon-32-byte".getBytes());
        assertThat(otherKey.unsubscribeId(token)).isEmpty();
        // Wrong shape or wrong length: a confirmation token (32 bytes but a wrong MAC), short, long, unusual
        // characters, with padding.
        assertThat(tokens.unsubscribeId(NewsletterTokens.newConfirmationToken()))
                .isEmpty();
        assertThat(tokens.unsubscribeId(token.substring(0, 30))).isEmpty();
        assertThat(tokens.unsubscribeId(token + "AAAA")).isEmpty();
        assertThat(tokens.unsubscribeId(token.substring(0, 42) + "+")).isEmpty();
        assertThat(tokens.unsubscribeId(token + "=")).isEmpty();
        assertThat(tokens.unsubscribeId(null)).isEmpty();
        assertThat(tokens.unsubscribeId("")).isEmpty();
    }

    @Test
    void blocking_code_is_a_deterministic_hmac_hex_per_address_and_per_key() {
        String hash = tokens.suppressionHash("alice@example.com");

        assertThat(hash).matches("[0-9a-f]{64}");
        assertThat(tokens.suppressionHash("alice@example.com")).isEqualTo(hash);
        assertThat(tokens.suppressionHash("alice+news@example.com")).isNotEqualTo(hash);
        assertThat(new NewsletterTokens("mot-khoa-khac-hoan-toan-dai-hon-32-byte".getBytes())
                        .suppressionHash("alice@example.com"))
                .isNotEqualTo(hash);
        // Not the bare SHA-256 of the address: without the key it cannot be recomputed from a list of addresses.
        assertThat(hash).isNotEqualTo(NewsletterTokens.sha256Hex("alice@example.com"));
    }

    private static String flip(String token, int index) {
        char replacement = token.charAt(index) == 'A' ? 'B' : 'A';
        return token.substring(0, index) + replacement + token.substring(index + 1);
    }
}
