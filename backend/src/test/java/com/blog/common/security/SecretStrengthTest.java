package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Base64;
import java.util.HexFormat;
import java.util.Random;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * The floor for a secret that a person may type by hand. The weak values are the ones the audit named (a dictionary word,
 * a repeated character, a repeated pattern, a placeholder); the strong values are what the documented commands produce.
 * The refusal must never hold the value.
 */
class SecretStrengthTest {

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(
            strings = {
                "   ",
                "changeme",
                "ChangeMe",
                "change-me-change-me-change-me-change-me",
                "secret",
                "password1password1password1password1",
                "this-is-my-secret-key",
                "change-me-openssl-rand-base64-48",
                "PASSWORD_SECRET_TOKEN",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "abababababababababababababababab",
                "abc123abc123abc123abc123abc123abc123",
                "0123456789abcdef0123456789abcdef",
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab",
                "abcdefghijklmnopqrstuvwxyz012345",
                "zyxwvutsrqponmlkjihgfedcba987654",
                "1234567890123456789012345678",
            })
    void a_weak_value_is_described_by_its_reason(String value) {
        assertThat(SecretStrength.weakness(value)).isPresent();
    }

    @Test
    void the_reason_never_holds_the_value() {
        String value = "changemechangemechangemechangeme";

        assertThatThrownBy(() -> SecretStrength.require("JWT_SECRET", value, 0, "openssl rand -base64 48"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("JWT_SECRET")
                .hasMessageContaining("openssl rand -base64 48")
                .hasMessageNotContaining(value)
                .hasMessageNotContaining("changeme");
    }

    @Test
    void a_short_value_is_refused_with_the_length_not_the_value() {
        assertThatThrownBy(() -> SecretStrength.require("VIEWS_TOKEN", "k3Jd9fQx2LmP", 16, "openssl rand -hex 32"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("VIEWS_TOKEN")
                .hasMessageContaining("shorter than 16")
                .hasMessageNotContaining("k3Jd9fQx2LmP");
        assertThatCode(() -> SecretStrength.require("VIEWS_TOKEN", "k3Jd9fQx2LmPz7Ws", 16, "openssl rand -hex 32"))
                .doesNotThrowAnyException();
    }

    @Test
    void a_long_phrase_that_merely_ends_in_a_sequence_is_not_a_sequence() {
        assertThat(SecretStrength.weakness("chuoi-bi-mat-jwt-cua-cai-dat-san-xuat-thu-nghiem-0123456789"))
                .isEmpty();
    }

    @Test
    void a_value_with_spaces_around_it_is_judged_without_them() {
        assertThat(SecretStrength.weakness("   aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  "))
                .isPresent();
        assertThat(SecretStrength.weakness("  8Ke0qWm3ZtR7vN1xYcB5uHjD2gLpA9sF  "))
                .isEmpty();
    }

    @Test
    void the_values_of_the_documented_commands_are_never_refused() {
        Random random = new Random(20261024L);
        for (int i = 0; i < 5000; i++) {
            // openssl rand -base64 48 (JWT_SECRET), openssl rand -base64 32, openssl rand -hex 32 (the tokens),
            // openssl rand -hex 16 (the shortest a person may reasonably make), scripts/init-env: hex of 24 or 48
            // bytes.
            assertThat(SecretStrength.weakness(base64(random, 48)))
                    .as("base64 of 48 bytes")
                    .isEmpty();
            assertThat(SecretStrength.weakness(base64(random, 32)))
                    .as("base64 of 32 bytes")
                    .isEmpty();
            assertThat(SecretStrength.weakness(hex(random, 32)))
                    .as("hex of 32 bytes")
                    .isEmpty();
            assertThat(SecretStrength.weakness(hex(random, 48)))
                    .as("hex of 48 bytes")
                    .isEmpty();
            assertThat(SecretStrength.weakness(hex(random, 24)))
                    .as("hex of 24 bytes")
                    .isEmpty();
            assertThat(SecretStrength.weakness(hex(random, 16)))
                    .as("hex of 16 bytes")
                    .isEmpty();
        }
    }

    private static String base64(Random random, int bytes) {
        byte[] value = new byte[bytes];
        random.nextBytes(value);
        return Base64.getEncoder().encodeToString(value);
    }

    private static String hex(Random random, int bytes) {
        byte[] value = new byte[bytes];
        random.nextBytes(value);
        return HexFormat.of().formatHex(value);
    }
}
