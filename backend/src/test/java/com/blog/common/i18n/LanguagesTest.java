package com.blog.common.i18n;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class LanguagesTest {

    private final Languages languages = new Languages(new I18nProperties(List.of("vi", "en"), "vi"));

    @Test
    void an_absent_or_blank_filter_means_no_filter_and_an_enabled_code_is_accepted_in_any_case() {
        assertThat(languages.optional(null)).isNull();
        assertThat(languages.optional("  ")).isNull();
        assertThat(languages.optional("en")).isEqualTo("en");
        assertThat(languages.require(" EN ")).isEqualTo("en");
    }

    @Test
    void a_code_that_is_not_enabled_is_a_validation_error() {
        assertThatThrownBy(() -> languages.optional("fr"))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.VALIDATION_ERROR));
        assertThatThrownBy(() -> languages.require("")).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> languages.require(null)).isInstanceOf(ApiException.class);
    }

    @Test
    void a_post_without_a_language_gets_the_default_locale() {
        assertThat(languages.orDefault(null)).isEqualTo("vi");
        assertThat(languages.orDefault("en")).isEqualTo("en");
    }

    @Test
    void the_default_locale_must_be_one_of_the_enabled_ones() {
        assertThatThrownBy(() -> new I18nProperties(List.of("vi", "en"), "de"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(new I18nProperties(null, null).defaultLocale()).isEqualTo("vi");
    }

    @Test
    void a_localized_text_falls_back_to_the_base_when_missing_or_blank() {
        Map<String, LocalizedText> translations = Map.of("en", new LocalizedText("Networks", " "));
        assertThat(LocalizedText.name(translations, "en", "Mang")).isEqualTo("Networks");
        assertThat(LocalizedText.name(translations, "vi", "Mang")).isEqualTo("Mang");
        assertThat(LocalizedText.name(null, "en", "Mang")).isEqualTo("Mang");
        assertThat(LocalizedText.description(translations, "en", "Goc")).isEqualTo("Goc");
    }
}
