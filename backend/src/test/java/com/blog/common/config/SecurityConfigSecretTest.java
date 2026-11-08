package com.blog.common.config;

import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * A JWT secret that is long enough but guessable is refused when the backend runs as production, and only then. The HS256
 * key is the single barrier between the internet and an ADMIN token, so a 32-character dictionary value or a repeated
 * character must not start a public site. The message names the reason, never the value. The values the documented
 * commands make are covered by SecretStrengthTest.
 */
class SecurityConfigSecretTest {

    private static final String PUBLIC_SITE = "https://blog.example.com";
    private static final String RANDOM_HEX = "3f9a7c1e5b2d8046a1c7e9f03b5d2a68c4e1f7a9035b8d2e6c1a4f7093e5b8d2";

    @ParameterizedTest
    @ValueSource(
            strings = {
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "changemechangemechangemechangeme",
                "ChangeMe-ChangeMe-ChangeMe-ChangeMe",
                "abababababababababababababababababab",
                "abcdefghijklmnopqrstuvwxyz0123456789",
            })
    void a_weak_secret_is_refused_on_a_public_site_without_echoing_it(String secret) {
        assertThatThrownBy(() -> SecurityConfig.refuseDevelopmentSecretInProduction(secret, true, PUBLIC_SITE, null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("JWT_SECRET")
                .hasMessageContaining("openssl rand -base64 48")
                .hasMessageNotContaining(secret);
    }

    @Test
    void a_weak_secret_is_refused_when_no_dev_opt_in_is_given_even_without_a_site_url() {
        assertThatThrownBy(() -> SecurityConfig.refuseDevelopmentSecretInProduction(
                        "changemechangemechangemechangeme", false, "", null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("JWT_SECRET")
                .hasMessageNotContaining("changeme");
    }

    @Test
    void a_random_secret_is_accepted_on_a_public_site() {
        assertThatCode(() -> SecurityConfig.refuseDevelopmentSecretInProduction(RANDOM_HEX, false, PUBLIC_SITE, null))
                .doesNotThrowAnyException();
        assertThatCode(() -> SecurityConfig.refuseDevelopmentSecretInProduction(RANDOM_HEX, true, PUBLIC_SITE, null))
                .doesNotThrowAnyException();
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "http://localhost:3000", "http://127.0.0.1:3100"})
    void an_opted_in_dev_machine_keeps_accepting_a_hand_typed_secret(String siteUrl) {
        assertThatCode(() -> SecurityConfig.refuseDevelopmentSecretInProduction(
                        "01234567890123456789012345678901", true, siteUrl, null))
                .doesNotThrowAnyException();
        assertThatCode(() -> SecurityConfig.refuseDevelopmentSecretInProduction(
                        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true, siteUrl, null))
                .doesNotThrowAnyException();
    }
}
