package com.blog.common.i18n;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.flywaydb.core.api.configuration.FluentConfiguration;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

/** The placeholder V34 reads is validated before any migration runs (a bad value must not leave a half-migrated database). */
class FlywayLocalePlaceholderTest {

    private static String placeholderFor(MockEnvironment environment) {
        FluentConfiguration configuration = new FluentConfiguration();
        new I18nConfig().defaultLocalePlaceholder(environment).customize(configuration);
        return configuration.getPlaceholders().get("defaultLocale");
    }

    @Test
    void an_empty_or_missing_value_is_the_first_enabled_locale_and_upper_case_is_lower_cased() {
        assertThat(placeholderFor(new MockEnvironment())).isEqualTo("vi");
        assertThat(placeholderFor(new MockEnvironment().withProperty("app.i18n.default-locale", "")))
                .isEqualTo("vi");
        assertThat(placeholderFor(new MockEnvironment()
                        .withProperty("app.i18n.locales", "vi,en")
                        .withProperty("app.i18n.default-locale", " EN ")))
                .isEqualTo("en");
    }

    @Test
    void a_value_with_a_quote_never_becomes_the_placeholder_that_V34_writes_into_DDL() {
        // The placeholder is substituted as SQL text. The list and the default are checked for their shape first, so
        // the
        // customiser fails before Flyway sees anything.
        assertThatThrownBy(() -> placeholderFor(new MockEnvironment()
                        .withProperty("app.i18n.locales", "vi,en,x'y")
                        .withProperty("app.i18n.default-locale", "x'y")))
                .hasStackTraceContaining("app.i18n.locales");
        assertThatThrownBy(() -> placeholderFor(new MockEnvironment()
                        .withProperty("app.i18n.locales", "vi,en")
                        .withProperty("app.i18n.default-locale", "vi'; DROP TABLE posts; --")))
                .hasStackTraceContaining("app.i18n.default-locale");
    }

    @Test
    void a_locale_that_is_not_enabled_stops_the_start_before_any_migration() {
        assertThatThrownBy(() -> placeholderFor(new MockEnvironment().withProperty("app.i18n.default-locale", "fr")))
                .hasStackTraceContaining("app.i18n.default-locale");
    }
}
