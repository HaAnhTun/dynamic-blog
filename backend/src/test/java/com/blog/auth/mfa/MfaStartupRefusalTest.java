package com.blog.auth.mfa;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.auth.oauth.GithubOAuthProperties;
import com.blog.common.config.SecurityProperties;
import com.blog.common.security.ProductionMode;
import com.blog.support.LogAssertions;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Arrays;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullAndEmptySource;
import org.junit.jupiter.params.provider.ValueSource;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * The backend does not start without a usable MFA_ENCRYPTION_KEY, in any mode; the development key and a key equal to
 * JWT_SECRET are refused unless the run opted in to development defaults. Like DevJwtSecretFailClosedTest, this checks the
 * RULE and the bean that applies it: the cipher is an eagerly built singleton, so the context cannot come up.
 *
 * No message may contain a key: a startup error is where a value lives the longest in the log.
 */
class MfaStartupRefusalTest {

    private static final String DEV = MfaProperties.DEV_ENCRYPTION_KEY;
    private static final String JWT = "mot-secret-that-dai-hon-32-byte-sinh-boi-openssl-rand";

    private static String key(int seed) {
        byte[] bytes = new byte[32];
        Arrays.fill(bytes, (byte) seed);
        return Base64.getEncoder().encodeToString(bytes);
    }

    private static MfaProperties properties(String key) {
        return new MfaProperties(key, "Blog", Duration.ofMinutes(5), Duration.ofMinutes(10), null, null, null);
    }

    private static SecurityProperties security(String jwtSecret) {
        return new SecurityProperties(
                jwtSecret,
                Duration.ofMinutes(15),
                Duration.ofDays(30),
                Duration.ofDays(7),
                Duration.ofMinutes(2),
                Duration.ofDays(7),
                Duration.ofDays(30));
    }

    private static ProductionMode mode(boolean devDefaultsAllowed) {
        return new ProductionMode(
                new GithubOAuthProperties(null, null, null, "http://localhost:3000", null), devDefaultsAllowed);
    }

    private MfaSecretCipher bean(String key, String jwtSecret, boolean devDefaultsAllowed) {
        return new MfaConfig().mfaSecretCipher(properties(key), security(jwtSecret), mode(devDefaultsAllowed));
    }

    @ParameterizedTest
    @NullAndEmptySource
    @ValueSource(strings = {"  "})
    void a_missing_key_refuses_to_start_in_every_mode(String missing) {
        for (boolean devDefaultsAllowed : new boolean[] {false, true}) {
            assertThatThrownBy(() -> bean(missing, JWT, devDefaultsAllowed))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("MFA_ENCRYPTION_KEY");
        }
    }

    @Test
    void a_key_of_the_wrong_length_refuses_with_the_length_only() {
        String sixteen = Base64.getEncoder().encodeToString(new byte[16]);
        String fortyEight = Base64.getEncoder().encodeToString(new byte[48]);

        assertThatThrownBy(() -> bean(sixteen, JWT, true))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("16 bytes")
                .hasMessageNotContaining(sixteen);
        assertThatThrownBy(() -> bean(fortyEight, JWT, false))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("48 bytes")
                .hasMessageNotContaining(fortyEight);
    }

    @Test
    void a_key_that_is_not_base64_refuses_without_echoing_it() {
        String notBase64 = "this is not base64 !!! at all, and it is secret";

        assertThatThrownBy(() -> bean(notBase64, JWT, true))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("base64")
                .hasMessageNotContaining(notBase64)
                .hasMessageNotContaining("secret");
    }

    @Test
    void the_development_key_is_refused_in_production_and_allowed_on_an_opted_in_run() {
        assertThatThrownBy(() -> bean(DEV, JWT, false))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("MFA_ENCRYPTION_KEY")
                .hasMessageContaining("APP_ALLOW_DEV_DEFAULTS")
                .hasMessageNotContaining(DEV);
        assertThat(bean(DEV, JWT, true)).isNotNull();
        // Whitespace around the pasted value does not hide it.
        assertThatThrownBy(() -> bean("  " + DEV + " \n", JWT, false)).isInstanceOf(IllegalStateException.class);
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                // No padding: the JDK decoder accepts it and reads the same 32 bytes.
                "kKTD05O9CzY77GBpadFxIY3buL3OixPWeQpATErrgxM",
                // A different last character that carries the same six high bits: the unused low bits are ignored.
                "kKTD05O9CzY77GBpadFxIY3buL3OixPWeQpATErrgxN=",
                "kKTD05O9CzY77GBpadFxIY3buL3OixPWeQpATErrgxP",
                "kKTD05O9CzY77GBpadFxIY3buL3OixPWeQpATErrgxM=\n",
            })
    void another_spelling_of_the_development_key_is_refused_in_production(String variant) {
        // The key is used as decoded bytes, so the refusal compares bytes: every text that decodes to the committed key
        // is the committed key.
        assertThat(MfaProperties.requireKeyBytes(variant)).isEqualTo(MfaProperties.requireKeyBytes(DEV));
        assertThat(variant).isNotEqualTo(DEV);

        assertThatThrownBy(() -> bean(variant, JWT, false))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("development key")
                .hasMessageNotContaining(variant.strip());
        assertThat(bean(variant, JWT, true)).isNotNull();
    }

    @Test
    void another_spelling_of_the_development_key_warns_on_an_opted_in_run() {
        Logger logger = (Logger) LoggerFactory.getLogger(DevMfaKeyWarning.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            new DevMfaKeyWarning(properties("kKTD05O9CzY77GBpadFxIY3buL3OixPWeQpATErrgxM"))
                    .run(new DefaultApplicationArguments());
            assertThat(appender.list).isNotEmpty().allMatch(event -> event.getLevel() == Level.WARN);
        } finally {
            logger.detachAppender(appender);
        }
    }

    @Test
    void a_jwt_secret_that_decodes_to_the_same_bytes_as_the_key_is_refused_in_production() {
        String shared = key(9);
        String unpadded = shared.substring(0, shared.indexOf('='));
        // The same text with different whitespace, and the same bytes in another spelling.
        assertThatThrownBy(() -> bean(shared, "  " + shared + "\n", false))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("JWT_SECRET");
        assertThatThrownBy(() -> bean(shared, unpadded, false))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("JWT_SECRET")
                .hasMessageNotContaining(shared);
        assertThat(bean(shared, unpadded, true)).isNotNull();
    }

    @Test
    void a_key_equal_to_the_jwt_secret_is_refused_in_production_and_allowed_on_an_opted_in_run() {
        String shared = key(9);

        assertThatThrownBy(() -> bean(shared, shared, false))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("JWT_SECRET")
                .hasMessageNotContaining(shared);
        assertThat(bean(shared, shared, true)).isNotNull();
    }

    @Test
    void a_real_key_is_accepted_in_every_mode() {
        // Control: the refusals above are because of the key, not because of the mode.
        assertThat(bean(key(3), JWT, false)).isNotNull();
        assertThat(bean(key(3), JWT, true)).isNotNull();
        assertThatCode(() -> MfaSecretCipher.refuseUnsafeKey(key(3), key(4), true))
                .doesNotThrowAnyException();
    }

    @Configuration(proxyBeanMethods = false)
    static class Beans {
        @Bean
        MfaSecretCipher cipher(org.springframework.core.env.Environment environment) {
            return new MfaConfig()
                    .mfaSecretCipher(
                            new MfaProperties(
                                    environment.getProperty("app.mfa.encryption-key"),
                                    "Blog",
                                    Duration.ofMinutes(5),
                                    Duration.ofMinutes(10),
                                    null,
                                    null,
                                    null),
                            security(JWT),
                            mode(true));
        }
    }

    @Test
    void a_context_without_the_key_does_not_start_and_with_one_it_does() {
        new ApplicationContextRunner().withUserConfiguration(Beans.class).run(context -> {
            assertThat(context.getStartupFailure()).isNotNull();
            Throwable root = context.getStartupFailure();
            while (root.getCause() != null) {
                root = root.getCause();
            }
            assertThat(root.getMessage()).contains("MFA_ENCRYPTION_KEY");
        });
        new ApplicationContextRunner()
                .withUserConfiguration(Beans.class)
                .withPropertyValues("app.mfa.encryption-key=" + key(5))
                .run(context -> assertThat(context).hasNotFailed().hasSingleBean(MfaSecretCipher.class));
    }

    @Test
    void the_development_key_warns_once_on_an_opted_in_run_and_other_keys_stay_quiet() {
        Logger logger = (Logger) LoggerFactory.getLogger(DevMfaKeyWarning.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            ApplicationArguments arguments = new DefaultApplicationArguments();
            new DevMfaKeyWarning(properties(key(6))).run(arguments);
            assertThat(appender.list).isEmpty();

            new DevMfaKeyWarning(properties(DEV)).run(arguments);
            assertThat(appender.list).isNotEmpty().allMatch(event -> event.getLevel() == Level.WARN);
            LogAssertions.assertNoValues(appender.list, DEV);
        } finally {
            logger.detachAppender(appender);
        }
    }

    @Test
    void application_yml_carries_no_key_and_the_dev_profile_and_the_test_configuration_carry_the_constant()
            throws Exception {
        // The dev key lives only in application-dev.yml and in the test configuration; if it drifts from the constant,
        // the
        // rule compares against a string nobody uses and silently never matches. application.yml must hold none.
        assertThat(resource("/application.yml")).doesNotContain(DEV);
        assertThat(resource("/application-dev.yml")).contains(DEV);
        assertThat(resource("/application.properties")).contains(DEV);
    }

    private String resource(String name) throws Exception {
        try (var in = getClass().getResourceAsStream(name)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
