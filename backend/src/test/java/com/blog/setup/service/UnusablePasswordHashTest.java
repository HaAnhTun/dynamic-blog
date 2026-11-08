package com.blog.setup.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import com.blog.common.security.SeedAdmin;
import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

/**
 * The marker that replaces the seeded admin's dev hash while setup is pending, against the REAL encoder of the
 * application (SecurityConfig): Spring Security's Argon2 decodes the stored value first and, for a value that is not an
 * Argon2 encoding, logs "Malformed password hash" and returns false. A throw would turn every login attempt on that
 * email into a 500, and DevCredentialWarning and AdminPasswordFromEnvironment would break the startup.
 */
class UnusablePasswordHashTest {

    private final PasswordEncoder encoder = Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8();

    @Test
    void no_password_matches_the_marker_and_checking_never_throws() {
        String marker = SetupAccounts.UNUSABLE_PASSWORD_HASH;
        for (String password : new String[] {SeedAdmin.DEV_PASSWORD, marker, "", "a-long-random-password-1234"}) {
            assertThatCode(() -> encoder.matches(password, marker)).doesNotThrowAnyException();
            assertThat(encoder.matches(password, marker)).as(password).isFalse();
        }
    }

    @Test
    void the_marker_fits_the_column_and_satisfies_the_credential_check() {
        // chk_users_has_credential needs a non-null hash; password_hash is VARCHAR(255).
        assertThat(SetupAccounts.UNUSABLE_PASSWORD_HASH).isNotBlank().hasSizeLessThanOrEqualTo(255);
        assertThat(SetupAccounts.UNUSABLE_PASSWORD_HASH).doesNotStartWith("$argon2");
    }
}
