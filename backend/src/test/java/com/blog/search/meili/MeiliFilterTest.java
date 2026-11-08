package com.blog.search.meili;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.fixtures.vi.SearchVi;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * Filter builder ("filter injection"): only allow-listed attributes, only slugs, always inside escaped double quotes.
 * A user string never becomes a filter expression.
 */
class MeiliFilterTest {

    @Test
    void valid_slug_becomes_a_comparison_in_double_quotes() {
        assertThat(MeiliFilter.equalTo("categorySlug", "spring-boot")).isEqualTo("categorySlug = \"spring-boot\"");
        assertThat(MeiliFilter.equalTo("tagSlugs", "c")).isEqualTo("tagSlugs = \"c\"");
        assertThat(MeiliFilter.in("type", List.of("category", "tag"))).isEqualTo("type IN [\"category\", \"tag\"]");
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "a\" OR type = \"post",
                "x OR 1 = 1",
                "spring boot",
                "Spring",
                "a\\",
                "tag\"]",
                "a = \"b\"",
                "type EXISTS",
                "slug_with_underscore",
                SearchVi.STREET,
                "",
                "a\u0000b",
                "a\nb"
            })
    void non_slug_value_is_rejected_before_any_call(String hostile) {
        assertThatThrownBy(() -> MeiliFilter.equalTo("categorySlug", hostile))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Filter value is not a slug");
        assertThatThrownBy(() -> MeiliFilter.in("type", List.of("post", hostile)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void attribute_outside_the_allow_list_is_rejected() {
        for (String attribute : List.of("title", "body", "status", "type = \"post\" OR id", "")) {
            assertThatThrownBy(() -> MeiliFilter.equalTo(attribute, "post"))
                    .as(attribute)
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessage("Attribute is not filterable");
        }
        assertThat(MeiliSettings.FILTERABLE)
                .containsExactlyInAnyOrder("type", "tagSlugs", "categorySlug", "seriesSlug", "language");
    }

    @Test
    void language_filter_is_the_language_or_a_document_without_one() {
        assertThat(MeiliFilter.languageOrMissing("vi")).isEqualTo("(language = \"vi\" OR language NOT EXISTS)");
        assertThat(MeiliFilter.languageOrMissing("en")).isEqualTo("(language = \"en\" OR language NOT EXISTS)");
    }

    @ParameterizedTest
    @ValueSource(
            strings = {"", "v", "VI", "vi\" OR type = \"post", "vi OR 1 = 1", "vi-VN", "a\\", "verylonglanguage", "v1"})
    void language_filter_rejects_anything_that_is_not_a_language_code(String hostile) {
        assertThatThrownBy(() -> MeiliFilter.languageOrMissing(hostile))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("Filter value is not a language");
        assertThatThrownBy(() -> MeiliFilter.languageOrMissing(null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void null_and_empty_in_are_rejected() {
        assertThatThrownBy(() -> MeiliFilter.equalTo("type", null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> MeiliFilter.in("type", List.of())).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void escapes_backslash_first_then_double_quote() {
        assertThat(MeiliFilter.quote("plain")).isEqualTo("\"plain\"");
        assertThat(MeiliFilter.quote("a\"b")).isEqualTo("\"a\\\"b\"");
        assertThat(MeiliFilter.quote("a\\b")).isEqualTo("\"a\\\\b\"");
        // A trailing backslash must not "eat" the closing quote.
        assertThat(MeiliFilter.quote("a\\")).isEqualTo("\"a\\\\\"");
        assertThat(MeiliFilter.quote("\\\" OR 1")).isEqualTo("\"\\\\\\\" OR 1\"");
    }
}
