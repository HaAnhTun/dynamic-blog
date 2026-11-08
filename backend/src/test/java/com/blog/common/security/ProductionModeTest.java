package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.auth.oauth.GithubOAuthProperties;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.mock.env.MockEnvironment;

/**
 * The backend "production": {@code SITE_URL} has a value and its host is not loopback. One rule for every
 * place that uses it (dev JWT secret, admin dev password, empty VIEWS_TOKEN), so it is checked once here, without a DB.
 */
class ProductionModeTest {

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"   ", "\t"})
    void empty_SITE_URL_is_dev(String siteUrl) {
        // Every IT and every dev machine does not set SITE_URL: it must run with the dev secret and password as before.
        assertThat(ProductionMode.isProduction(siteUrl)).isFalse();
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "http://localhost:3000",
                "http://LOCALHOST:3000/",
                " http://localhost:3100 ",
                "http://127.0.0.1:3000",
                "http://127.1.2.3:8080",
                "http://[::1]:3000",
                "https://localhost"
            })
    void loopback_SITE_URL_is_dev(String siteUrl) {
        assertThat(ProductionMode.isProduction(siteUrl)).isFalse();
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "https://blog.example.com",
                "http://blog.example.com",
                "https://blog.example.com:8443/",
                "http://192.168.1.10:3000",
                "http://10.0.0.5",
                "http://0.0.0.0:3000",
                "http://[::]:3000",
                "http://localhost.example.com",
                "http://127.0.0.1.example.com"
            })
    void SITE_URL_with_non_loopback_host_is_production(String siteUrl) {
        assertThat(ProductionMode.isProduction(siteUrl)).isTrue();
    }

    @ParameterizedTest
    @ValueSource(strings = {"blog.example.com", "localhost:3000", "http://", "http://bad host/", "::::"})
    void SITE_URL_whose_host_cannot_be_read_is_treated_as_production(String siteUrl) {
        // It has a value but cannot be proven loopback: pick the safe side. The error message names SITE_URL, so the
        // operator can fix it right away.
        assertThat(ProductionMode.isProduction(siteUrl)).isTrue();
    }

    @Test
    void loopback_is_localhost_127_0_0_0_8_and_1_nothing_else() {
        assertThat(ProductionMode.isLoopbackHost("localhost")).isTrue();
        assertThat(ProductionMode.isLoopbackHost("LocalHost")).isTrue();
        assertThat(ProductionMode.isLoopbackHost("127.0.0.1")).isTrue();
        assertThat(ProductionMode.isLoopbackHost("127.255.255.254")).isTrue();
        // URI.getHost() returns IPv6 with square brackets.
        assertThat(ProductionMode.isLoopbackHost("[::1]")).isTrue();
        assertThat(ProductionMode.isLoopbackHost("::1")).isTrue();

        assertThat(ProductionMode.isLoopbackHost(null)).isFalse();
        assertThat(ProductionMode.isLoopbackHost("")).isFalse();
        assertThat(ProductionMode.isLoopbackHost("128.0.0.1")).isFalse();
        assertThat(ProductionMode.isLoopbackHost("0.0.0.0")).isFalse();
        assertThat(ProductionMode.isLoopbackHost("::")).isFalse();
        assertThat(ProductionMode.isLoopbackHost("example.com")).isFalse();
        // Not a valid IP address, no DNS lookup: not loopback.
        assertThat(ProductionMode.isLoopbackHost("127.0.0.256")).isFalse();
        assertThat(ProductionMode.isLoopbackHost("localhost.")).isFalse();
    }

    @Test
    void opted_in_bean_reads_SITE_URL_of_github_configuration_once() {
        assertThat(new ProductionMode(siteUrl("https://blog.example.com"), true).active())
                .isTrue();
        assertThat(new ProductionMode(siteUrl("http://localhost:3000"), true).active())
                .isFalse();
        assertThat(new ProductionMode(siteUrl(null), true).active()).isFalse();
    }

    @Test
    void without_the_opt_in_every_run_is_production_even_on_localhost_or_with_an_empty_SITE_URL() {
        for (String url : new String[] {null, "", "http://localhost:3000", "http://127.0.0.1:3100"}) {
            ProductionMode mode = new ProductionMode(siteUrl(url), false);
            assertThat(mode.active()).as(String.valueOf(url)).isTrue();
            assertThat(mode.devDefaultsAllowed()).isFalse();
        }
    }

    @Test
    void empty_SITE_URL_with_a_public_GITHUB_REDIRECT_URI_counts_as_active_even_with_the_opt_in() {
        GithubOAuthProperties oauth =
                new GithubOAuthProperties(null, null, "https://example.com/api/auth/github/callback", null, null);
        assertThat(new ProductionMode(oauth, true).active()).isTrue();
        assertThat(ProductionMode.isProduction(null, "https://example.com/api/auth/github/callback"))
                .isTrue();
        assertThat(ProductionMode.isProduction(null, "http://localhost:3000/api/auth/github/callback"))
                .isFalse();
    }

    @Test
    void opt_in_is_the_dev_profile_or_APP_ALLOW_DEV_DEFAULTS_and_nothing_else() {
        assertThat(ProductionMode.devDefaultsAllowed(new MockEnvironment())).isFalse();
        assertThat(ProductionMode.devDefaultsAllowed(new MockEnvironment().withProperty("SITE_URL", "")))
                .isFalse();
        MockEnvironment dev = new MockEnvironment();
        dev.setActiveProfiles("dev");
        assertThat(ProductionMode.devDefaultsAllowed(dev)).isTrue();
        assertThat(ProductionMode.devDefaultsAllowed(
                        new MockEnvironment().withProperty("app.allow-dev-defaults", "true")))
                .isTrue();
        assertThat(ProductionMode.devDefaultsAllowed(
                        new MockEnvironment().withProperty("app.allow-dev-defaults", "false")))
                .isFalse();
        MockEnvironment other = new MockEnvironment();
        other.setActiveProfiles("prod");
        assertThat(ProductionMode.devDefaultsAllowed(other)).isFalse();
    }

    static GithubOAuthProperties siteUrl(String siteUrl) {
        return new GithubOAuthProperties(null, null, null, siteUrl, null);
    }
}
