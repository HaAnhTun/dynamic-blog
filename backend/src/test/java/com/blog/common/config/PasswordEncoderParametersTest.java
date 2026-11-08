package com.blog.common.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

/**
 * The Argon2id cost of a stored password hash. The floor is the OWASP Password Storage Cheat Sheet minimum for Argon2id
 * (19 MiB of memory, 2 iterations, 1 degree of parallelism); Spring Security's own defaults use 16 MiB and are below it.
 * A plain unit test: the encoder is built without a Spring context.
 */
class PasswordEncoderParametersTest {

    private static final Pattern PARAMETERS =
            Pattern.compile("^[$]argon2id[$]v=19[$]m=([0-9]+),t=([0-9]+),p=([0-9]+)[$]");

    private final PasswordEncoder encoder = new SecurityConfig().passwordEncoder();

    @Test
    void a_new_hash_is_argon2id_at_or_above_the_owasp_minimum() {
        String hash = encoder.encode("a-password-for-the-parameter-test");

        Matcher parameters = PARAMETERS.matcher(hash);
        assertThat(parameters.find()).as("an Argon2id encoding with version 19").isTrue();
        assertThat(Integer.parseInt(parameters.group(1))).as("memory in KiB").isGreaterThanOrEqualTo(19_456);
        assertThat(Integer.parseInt(parameters.group(2))).as("iterations").isGreaterThanOrEqualTo(2);
        assertThat(Integer.parseInt(parameters.group(3))).as("parallelism").isGreaterThanOrEqualTo(1);
        assertThat(encoder.matches("a-password-for-the-parameter-test", hash)).isTrue();
        assertThat(encoder.matches("another-password", hash)).isFalse();
    }

    @Test
    void a_hash_made_with_the_old_spring_defaults_still_verifies_and_is_marked_for_upgrade() {
        String old = Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8().encode("an-older-password-value");
        assertThat(old).contains("m=16384,");

        assertThat(encoder.matches("an-older-password-value", old)).isTrue();
        assertThat(encoder.upgradeEncoding(old)).isTrue();
    }

    @Test
    void a_hash_with_the_current_parameters_is_not_marked_for_upgrade() {
        assertThat(encoder.upgradeEncoding(encoder.encode("a-current-password-value")))
                .isFalse();
    }
}
