package com.blog.common.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.auth.oauth.GithubOAuthProperties;
import com.blog.common.security.ProductionMode;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.security.oauth2.jwt.JwtEncoder;

/**
 * The backend is fail-closed: without an explicit opt-in to development defaults (Spring profile dev, or
 * APP_ALLOW_DEV_DEFAULTS=true) it does not start with a missing or committed dev JWT secret, whatever SITE_URL says:
 * anyone who reads the repository could sign an ADMIN token for that instance. A public SITE_URL is refused even with
 * the opt-in.
 *
 * Like JwtSecretLengthTest, this file checks the RULE, not the startup order: the rule runs in {@code jwtEncoder}, an
 * early-built singleton, so the context cannot come up and Tomcat never accepted a connection.
 *
 * No message may contain the secret: a startup error is where a value lives the longest in the log.
 */
class DevJwtSecretFailClosedTest {

    private static final String DEV = SecurityProperties.DEV_JWT_SECRET;
    private static final String REAL = "mot-secret-that-dai-hon-32-byte-sinh-boi-openssl-rand";

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"http://localhost:3000", "https://blog.example.com", "  "})
    void dev_secret_without_opt_in_is_rejected_whatever_SITE_URL_says(String siteUrl) {
        assertThatThrownBy(() -> SecurityConfig.refuseDevelopmentSecretInProduction(DEV, false, siteUrl, null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("JWT_SECRET")
                .hasMessageContaining("APP_ALLOW_DEV_DEFAULTS")
                .hasMessageNotContaining(DEV)
                .hasMessageNotContaining("dev-only-secret");
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"  "})
    void missing_secret_without_opt_in_is_rejected_naming_the_variable(String secret) {
        assertThatThrownBy(() -> SecurityConfig.refuseDevelopmentSecretInProduction(secret, false, "", null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("JWT_SECRET");
        assertThatThrownBy(() -> SecurityConfig.requireUsableSecret(secret))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("JWT_SECRET");
    }

    @ParameterizedTest
    @ValueSource(strings = {"https://blog.example.com", "http://203.0.113.7:3000", "blog.example.com"})
    void dev_secret_with_public_SITE_URL_is_rejected_even_with_the_opt_in(String siteUrl) {
        assertThatThrownBy(() -> SecurityConfig.refuseDevelopmentSecretInProduction(DEV, true, siteUrl, null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("JWT_SECRET")
                .hasMessageNotContaining(DEV)
                .hasMessageNotContaining(siteUrl);
    }

    @Test
    void dev_secret_with_a_public_GITHUB_REDIRECT_URI_is_rejected_even_with_the_opt_in() {
        assertThatThrownBy(() -> SecurityConfig.refuseDevelopmentSecretInProduction(
                        DEV, true, "", "https://example.com/api/auth/github/callback"))
                .isInstanceOf(IllegalStateException.class);
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"http://localhost:3000", "http://127.0.0.1:3100", "http://[::1]:3000", "  "})
    void dev_secret_with_the_opt_in_on_a_dev_machine_starts(String siteUrl) {
        assertThatCode(() -> SecurityConfig.refuseDevelopmentSecretInProduction(DEV, true, siteUrl, null))
                .doesNotThrowAnyException();
    }

    @Test
    void real_secret_is_accepted_in_every_mode() {
        // Control: the rejections above are because of the dev secret, not because of the mode or the SITE_URL.
        assertThatCode(() -> SecurityConfig.refuseDevelopmentSecretInProduction(
                        REAL, false, "https://blog.example.com", null))
                .doesNotThrowAnyException();
        assertThatCode(() -> SecurityConfig.refuseDevelopmentSecretInProduction(REAL, false, "", null))
                .doesNotThrowAnyException();
        // Only exactly the dev value: a secret that differs by a single character is a different secret.
        assertThatCode(() -> SecurityConfig.refuseDevelopmentSecretInProduction(DEV + "x", false, "", null))
                .doesNotThrowAnyException();
    }

    @Test
    void jwtEncoder_bean_method_applies_the_rule() {
        SecurityConfig config = new SecurityConfig();
        GithubOAuthProperties local = new GithubOAuthProperties(null, null, null, "http://localhost:3000", null);
        SecurityProperties devSecret = properties(DEV);

        assertThatThrownBy(() -> config.jwtEncoder(devSecret, local, new MockEnvironment()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("JWT_SECRET")
                .hasMessageNotContaining(DEV);
        assertThatThrownBy(() -> config.jwtEncoder(properties(null), local, devProfile()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("JWT_SECRET");
        assertThat(config.jwtEncoder(devSecret, local, devProfile())).isNotNull();
        assertThat(config.jwtEncoder(
                        devSecret,
                        local,
                        new MockEnvironment().withProperty(ProductionMode.ALLOW_DEV_DEFAULTS_PROPERTY, "true")))
                .isNotNull();
    }

    private static Environment devProfile() {
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles(ProductionMode.DEV_PROFILE);
        return environment;
    }

    private static SecurityProperties properties(String secret) {
        return new SecurityProperties(
                secret,
                Duration.ofMinutes(15),
                Duration.ofDays(30),
                Duration.ofDays(7),
                Duration.ofMinutes(2),
                Duration.ofDays(7),
                Duration.ofDays(30));
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties({SecurityProperties.class, GithubOAuthProperties.class})
    static class SecurityBeans {
        @Bean
        JwtEncoder jwtEncoder(SecurityProperties properties, GithubOAuthProperties oauth, Environment environment) {
            return new SecurityConfig().jwtEncoder(properties, oauth, environment);
        }
    }

    @Test
    void context_without_JWT_SECRET_and_without_the_dev_profile_does_not_start() {
        new ApplicationContextRunner()
                .withUserConfiguration(SecurityBeans.class)
                .run(context -> {
                    assertThat(context.getStartupFailure()).isNotNull();
                    assertThat(rootMessage(context.getStartupFailure())).contains("JWT_SECRET");
                });
    }

    @Test
    void context_with_the_dev_secret_and_no_opt_in_does_not_start() {
        new ApplicationContextRunner()
                .withUserConfiguration(SecurityBeans.class)
                .withPropertyValues("app.security.jwt-secret=" + DEV)
                .run(context -> {
                    assertThat(context.getStartupFailure()).isNotNull();
                    assertThat(rootMessage(context.getStartupFailure()))
                            .contains("JWT_SECRET")
                            .doesNotContain(DEV);
                });
    }

    @Test
    void context_with_the_dev_secret_and_the_opt_in_starts() {
        new ApplicationContextRunner()
                .withUserConfiguration(SecurityBeans.class)
                .withPropertyValues("app.security.jwt-secret=" + DEV, "app.allow-dev-defaults=true")
                .run(context -> assertThat(context).hasNotFailed().hasSingleBean(JwtEncoder.class));
    }

    @Test
    void context_with_a_real_secret_starts_without_any_opt_in() {
        new ApplicationContextRunner()
                .withUserConfiguration(SecurityBeans.class)
                .withPropertyValues("app.security.jwt-secret=" + REAL)
                .run(context -> assertThat(context).hasNotFailed());
    }

    @Test
    void application_yml_carries_no_secret_and_application_dev_yml_carries_exactly_the_constant() throws Exception {
        // The dev string lives in application-dev.yml and in the test configuration; if it drifts from the constant,
        // the rule compares against a string nobody uses and silently never matches. application.yml must hold none.
        String yml = resource("/application.yml");
        String dev = resource("/application-dev.yml");
        assertThat(yml).doesNotContain(DEV).doesNotContain("dev-only-secret");
        assertThat(dev).contains(DEV);
    }

    private String resource(String name) throws Exception {
        try (var in = getClass().getResourceAsStream(name)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static String rootMessage(Throwable failure) {
        Throwable root = failure;
        while (root.getCause() != null) {
            root = root.getCause();
        }
        return String.valueOf(root.getMessage());
    }
}
