package com.blog.common.config;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.common.security.AdminAccountProperties;
import java.time.Duration;
import org.junit.jupiter.api.Test;

/**
 * The properties records that hold the signing key and the administrator password print neither. The other
 * secret-bearing properties already did (ViewsProperties, ClientIpProperties, SetupProperties, MfaProperties); these two
 * did not, and a configuration object is exactly what ends up in a startup error or a debug line. A plain unit test, no
 * Spring context.
 */
class SecretPropertiesToStringTest {

    private static final String SECRET = "unit-test-signing-key-that-must-never-be-printed-0123456789";
    private static final String PASSWORD = "unit-test-admin-password-not-printed";

    @Test
    void security_properties_print_no_signing_key_but_keep_the_lifetimes() {
        SecurityProperties properties = new SecurityProperties(
                SECRET,
                Duration.ofMinutes(15),
                Duration.ofDays(30),
                Duration.ofDays(7),
                Duration.ofMinutes(2),
                Duration.ofDays(7),
                Duration.ofDays(30));

        assertThat(properties.toString())
                .doesNotContain(SECRET)
                .contains("<set>")
                .contains("PT15M")
                .contains("PT720H");
        assertThat(new SecurityProperties(null, null, null, Duration.ZERO, Duration.ZERO, null, null).toString())
                .contains("<unset>");
        assertThat(new SecurityProperties(
                                SecurityProperties.DEV_JWT_SECRET, null, null, Duration.ZERO, Duration.ZERO, null, null)
                        .toString())
                .contains("<dev-default>")
                .doesNotContain(SecurityProperties.DEV_JWT_SECRET);
    }

    @Test
    void admin_account_properties_print_no_password_and_no_address() {
        AdminAccountProperties properties = new AdminAccountProperties("owner@example.test", PASSWORD, "12345");

        assertThat(properties.toString())
                .doesNotContain(PASSWORD)
                .doesNotContain("owner@example.test")
                .contains("<set>")
                .contains("12345");
        assertThat(new AdminAccountProperties("owner@example.test", null, null).toString())
                .contains("<unset>");
    }
}
