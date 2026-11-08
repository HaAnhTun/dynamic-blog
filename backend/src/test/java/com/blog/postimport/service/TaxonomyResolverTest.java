package com.blog.postimport.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.common.i18n.LocalizedText;
import com.blog.postimport.format.PostNormalForm;
import com.blog.postimport.service.TaxonomyResolver.Entry;
import com.blog.postimport.service.TaxonomyResolver.Outcome;
import com.blog.postimport.service.TaxonomyResolver.Result;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** The category and tag resolver: strip, NFC, ignoring case, in the order language translation, base name, other translations. */
class TaxonomyResolverTest {

    private static final UUID GUIDES = UUID.randomUUID();
    private static final UUID NEWS = UUID.randomUUID();
    private static final UUID CAFE = UUID.randomUUID();

    private static Entry entry(UUID id, String name, Map<String, LocalizedText> translations) {
        return new Entry(id, name, translations);
    }

    private static Map<String, LocalizedText> names(String... languageAndName) {
        Map<String, LocalizedText> translations = new java.util.LinkedHashMap<>();
        for (int i = 0; i < languageAndName.length; i += 2) {
            translations.put(languageAndName[i], new LocalizedText(languageAndName[i + 1], null));
        }
        return translations;
    }

    private static Result resolve(String name, String language, Entry... entries) {
        return TaxonomyResolver.resolve(name, language, List.of(entries));
    }

    @Test
    void a_name_is_matched_ignoring_case_and_surrounding_spaces() {
        Result result = resolve("  gUIDes \t", "en", entry(GUIDES, "Guides", Map.of()));

        assertThat(result.outcome()).isEqualTo(Outcome.FOUND);
        assertThat(result.id()).isEqualTo(GUIDES);
    }

    @Test
    void a_name_is_compared_in_nfc_so_a_decomposed_letter_matches_the_composed_one() {
        String composed = "Caf" + (char) 0xE9;
        String decomposed = "Cafe" + (char) 0x301;

        assertThat(resolve(decomposed, "en", entry(CAFE, composed, Map.of())).id())
                .isEqualTo(CAFE);
        assertThat(resolve(composed, "en", entry(CAFE, decomposed, Map.of())).id())
                .isEqualTo(CAFE);
    }

    @Test
    void a_name_that_nothing_has_is_missing() {
        Result result = resolve("Unknown", "en", entry(GUIDES, "Guides", names("vi", "Huong dan")));

        assertThat(result.outcome()).isEqualTo(Outcome.MISSING);
        assertThat(result.id()).isNull();
    }

    @Test
    void the_translation_in_the_language_of_the_post_wins_over_a_base_name() {
        Entry translated = entry(GUIDES, "Guides", names("vi", "Notes"));
        Entry base = entry(NEWS, "Notes", Map.of());

        assertThat(resolve("notes", "vi", translated, base).id()).isEqualTo(GUIDES);
        // In another language the translation is not the first step, so the base name decides.
        assertThat(resolve("notes", "en", translated, base).id()).isEqualTo(NEWS);
    }

    @Test
    void the_base_name_wins_over_a_translation_in_another_language() {
        Entry other = entry(GUIDES, "Guides", names("fr", "Notes"));
        Entry base = entry(NEWS, "Notes", Map.of());

        assertThat(resolve("Notes", "en", other, base).id()).isEqualTo(NEWS);
    }

    @Test
    void a_translation_in_another_language_is_found_when_nothing_else_matches() {
        Result result = resolve("Huong dan", "en", entry(GUIDES, "Guides", names("vi", "Huong dan")));

        assertThat(result.outcome()).isEqualTo(Outcome.FOUND);
        assertThat(result.id()).isEqualTo(GUIDES);
    }

    @Test
    void a_blank_translation_is_not_a_name_and_the_language_step_falls_through_to_the_base_name() {
        Result result = resolve("Guides", "vi", entry(GUIDES, "Guides", names("vi", "   ")));

        assertThat(result.id()).isEqualTo(GUIDES);
    }

    @Test
    void more_than_one_candidate_in_the_deciding_step_is_ambiguous_and_names_no_id() {
        Entry first = entry(GUIDES, "Guides", names("en", "Shared"));
        Entry second = entry(NEWS, "News", names("en", "shared"));

        Result inLanguage = resolve("SHARED", "en", first, second);
        assertThat(inLanguage.outcome()).isEqualTo(Outcome.AMBIGUOUS);
        assertThat(inLanguage.id()).isNull();

        Entry base = entry(GUIDES, "Same", Map.of());
        Entry sameBase = entry(NEWS, "same", Map.of());
        assertThat(resolve("same", "en", base, sameBase).outcome()).isEqualTo(Outcome.AMBIGUOUS);

        Entry viaFrench = entry(GUIDES, "A", names("fr", "Both"));
        Entry viaSpanish = entry(NEWS, "B", names("es", "both"));
        assertThat(resolve("both", "en", viaFrench, viaSpanish).outcome()).isEqualTo(Outcome.AMBIGUOUS);
    }

    @Test
    void one_entry_matching_in_two_languages_is_one_candidate_not_an_ambiguity() {
        Entry entry = entry(GUIDES, "Guides", names("fr", "Same", "es", "same"));

        assertThat(resolve("same", "en", entry).outcome()).isEqualTo(Outcome.FOUND);
    }

    @Test
    void a_name_equal_to_the_download_form_of_an_attached_tag_is_that_tag_not_a_new_one() {
        Entry attached = entry(GUIDES, "red, green", Map.of());
        Entry other = entry(NEWS, "red green", Map.of());

        Result written = TaxonomyResolver.resolveAttached(
                "red green", "en", List.of(attached, other), List.of(GUIDES), PostNormalForm::tag);

        assertThat(written.outcome()).isEqualTo(Outcome.FOUND);
        assertThat(written.id()).isEqualTo(GUIDES);
        // Without it attached, the same name is the other tag, and an unknown name stays missing.
        assertThat(TaxonomyResolver.resolveAttached(
                                "red green", "en", List.of(attached, other), List.of(), PostNormalForm::tag)
                        .id())
                .isEqualTo(NEWS);
        assertThat(TaxonomyResolver.resolveAttached(
                                "blue", "en", List.of(attached), List.of(GUIDES), PostNormalForm::tag)
                        .outcome())
                .isEqualTo(Outcome.MISSING);
    }

    @Test
    void the_download_form_of_a_localised_name_of_an_attached_category_is_that_category() {
        Entry attached = entry(GUIDES, "Guides", names("fr", "Handbooks --- fr"));
        String written = "Handbooks " + (char) 0x2014 + " fr";

        Result result = TaxonomyResolver.resolveAttached(
                written, "fr", List.of(attached), List.of(GUIDES), PostNormalForm::line);

        assertThat(result.id()).isEqualTo(GUIDES);
    }
}
