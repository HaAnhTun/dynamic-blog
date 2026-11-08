package com.blog.common.i18n;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * The content languages are checked for their shape before anything uses them: the default one becomes the Flyway
 * placeholder {@code defaultLocale} that V34 writes into DDL as SQL text, and the list is what Languages accepts from every
 * request. A bad value stops the start with a message that names the setting, so it never reaches the migration (V34
 * is applied and cannot change).
 */
class I18nPropertiesTest {

    @ParameterizedTest
    @ValueSource(
            strings = {"x'y", "vi;DROP TABLE posts", "e", "abcdefghi", "v1", "vi-VN", "vi en", "vi\ten", "v\u00ed", "--"
            })
    void a_locale_that_is_not_two_to_eight_letters_stops_the_start(String bad) {
        assertThatThrownBy(() -> new I18nProperties(List.of("vi", bad), "vi"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.i18n.locales");
        if (bad.length() > 3) {
            // The refusal never echoes the value (a short one such as "e" would match the fixed text of the message).
            assertThatThrownBy(() -> new I18nProperties(List.of("vi", bad), "vi"))
                    .hasMessageNotContaining(bad);
        }
        // The default locale is read as SQL text by V34, so a bad one is refused before it can be the placeholder.
        assertThatThrownBy(() -> new I18nProperties(List.of("vi", "en"), bad))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.i18n");
    }

    @Test
    void an_empty_entry_and_a_duplicate_stop_the_start() {
        assertThatThrownBy(() -> new I18nProperties(List.of("vi", " ", "en"), "vi"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.i18n.locales");
        assertThatThrownBy(() -> new I18nProperties(List.of("vi", "en", " VI "), "vi"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.i18n.locales")
                .hasMessageContaining("twice");
    }

    @Test
    void a_valid_list_is_trimmed_lower_cased_and_keeps_its_order() {
        I18nProperties properties = new I18nProperties(List.of(" VI ", "en"), null);

        assertThat(properties.locales()).containsExactly("vi", "en");
        assertThat(properties.defaultLocale()).isEqualTo("vi");
        assertThat(new I18nProperties(List.of("vi", "en", "fr"), " EN ").defaultLocale())
                .isEqualTo("en");
        assertThat(new I18nProperties(null, null).locales()).containsExactly("vi", "en");
    }
}
