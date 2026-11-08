package com.blog.common.i18n;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class TaxonomyTranslationsTest {

    private final TaxonomyTranslations translations =
            new TaxonomyTranslations(new Languages(new I18nProperties(List.of("vi", "en"), "vi")));

    @Test
    void texts_are_stripped_blank_texts_become_null_and_empty_entries_are_dropped() {
        Map<String, LocalizedText> input = new HashMap<>();
        input.put("en", new LocalizedText("  Name  ", " "));
        input.put("vi", new LocalizedText(" ", ""));

        Map<String, LocalizedText> result = translations.normalize(input, 100, 100);

        assertThat(result).containsOnlyKeys("en");
        assertThat(result.get("en")).isEqualTo(new LocalizedText("Name", null));
    }

    @Test
    void absent_and_null_entries_give_an_empty_map() {
        assertThat(translations.normalize(null, 10, 10)).isEmpty();
        Map<String, LocalizedText> input = new HashMap<>();
        input.put("en", null);
        assertThat(translations.normalize(input, 10, 10)).isEmpty();
    }

    @Test
    void a_key_that_is_not_an_enabled_locale_is_a_validation_error_and_a_known_one_is_lower_cased() {
        assertThatThrownBy(() -> translations.normalize(Map.of("fr", new LocalizedText("Nom", null)), 10, 10))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.VALIDATION_ERROR));
        assertThat(translations.normalize(Map.of("EN", new LocalizedText("Name", null)), 10, 10))
                .containsOnlyKeys("en");
    }

    @Test
    void lengths_are_checked_after_stripping() {
        assertThat(translations.normalize(Map.of("en", new LocalizedText("  abcde  ", null)), 5, 5))
                .containsOnlyKeys("en");
        assertThatThrownBy(() -> translations.normalize(Map.of("en", new LocalizedText("abcdef", null)), 5, 5))
                .isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> translations.normalize(Map.of("en", new LocalizedText(null, "abcdef")), 5, 5))
                .isInstanceOf(ApiException.class);
    }

    @Test
    void a_translated_name_with_a_line_break_is_a_validation_error_but_a_description_may_have_lines() {
        String broken = "a" + (char) 10 + "b";
        assertThatThrownBy(() -> translations.normalize(Map.of("en", new LocalizedText(broken, null)), 50, 50))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.VALIDATION_ERROR));
        assertThat(translations.normalize(Map.of("en", new LocalizedText("Name", broken)), 50, 50))
                .containsOnlyKeys("en");
    }

    @Test
    void invisible_and_text_direction_characters_are_removed_from_a_translated_name() {
        String name = "na" + new String(Character.toChars(0x202E)) + "me";
        String blank = new String(Character.toChars(0x200B));

        Map<String, LocalizedText> result = translations.normalize(
                Map.of("en", new LocalizedText(name, null), "vi", new LocalizedText(blank, null)), 50, 50);

        assertThat(result).containsOnlyKeys("en");
        assertThat(result.get("en").name()).isEqualTo("name");
    }
}
