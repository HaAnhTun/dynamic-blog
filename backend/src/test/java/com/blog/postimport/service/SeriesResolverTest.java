package com.blog.postimport.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.common.i18n.LocalizedText;
import com.blog.postimport.service.SeriesResolver.Entry;
import com.blog.postimport.service.TaxonomyResolver.Outcome;
import com.blog.postimport.service.TaxonomyResolver.Result;
import java.text.Normalizer;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** How a name in a post file finds its series: slug or title, case, accents, translations, ambiguity and the attached series. */
class SeriesResolverTest {

    private static final UUID QUEUES = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID CAFE = UUID.fromString("00000000-0000-0000-0000-0000000000b2");
    private static final UUID OTHER = UUID.fromString("00000000-0000-0000-0000-0000000000c3");

    private static final Entry QUEUES_SERIES = new Entry(QUEUES, "Queues in practice", "queues-in-practice", Map.of());
    private static final Entry CAFE_SERIES = new Entry(CAFE, "Caf\u00e9 notes", "cafe-notes", Map.of());
    private static final Entry TRANSLATED =
            new Entry(OTHER, "Base title", "base-title", Map.of("vi", new LocalizedText("Ten dich", null)));

    private static final List<Entry> ALL = List.of(QUEUES_SERIES, CAFE_SERIES, TRANSLATED);

    private static Result found(UUID id) {
        return new Result(Outcome.FOUND, id);
    }

    @Test
    void a_name_equal_to_the_title_ignoring_case_and_surrounding_space_is_that_series() {
        assertThat(SeriesResolver.resolve("  QUEUES in Practice ", null, ALL)).isEqualTo(found(QUEUES));
    }

    @Test
    void a_name_that_differs_from_the_title_only_by_how_it_is_written_as_a_slug_is_that_series() {
        // The title has an accent, the name has none: the titles are not folded, the slugs are.
        assertThat(SeriesResolver.resolve("Cafe Notes", null, ALL)).isEqualTo(found(CAFE));
        assertThat(SeriesResolver.resolve("cafe-notes", null, ALL)).isEqualTo(found(CAFE));
        assertThat(SeriesResolver.resolve("Queues--in   practice!", null, ALL)).isEqualTo(found(QUEUES));
    }

    @Test
    void the_composed_and_decomposed_forms_of_an_accent_are_the_same_name() {
        String decomposed = Normalizer.normalize("Caf\u00e9 notes", Normalizer.Form.NFD);

        assertThat(SeriesResolver.resolve(decomposed, null, ALL)).isEqualTo(found(CAFE));
    }

    @Test
    void a_translated_title_is_the_series_too() {
        assertThat(SeriesResolver.resolve("ten dich", null, ALL)).isEqualTo(found(OTHER));
    }

    @Test
    void a_name_nobody_has_is_missing() {
        assertThat(SeriesResolver.resolve("A brand new series", null, ALL))
                .isEqualTo(new Result(Outcome.MISSING, null));
    }

    @Test
    void a_name_without_letters_does_not_match_every_series_through_an_empty_slug() {
        assertThat(SeriesResolver.resolve("!!!", null, ALL)).isEqualTo(new Result(Outcome.MISSING, null));
    }

    @Test
    void a_name_that_two_series_answer_to_is_ambiguous() {
        // One series has this as its slug, another has this as its title.
        Entry bySlug = new Entry(UUID.randomUUID(), "Something else", "shared-name", Map.of());
        Entry byTitle = new Entry(UUID.randomUUID(), "Shared name", "another-slug", Map.of());

        assertThat(SeriesResolver.resolve("Shared Name", null, List.of(bySlug, byTitle)))
                .isEqualTo(new Result(Outcome.AMBIGUOUS, null));
    }

    @Test
    void the_series_the_post_is_in_wins_over_the_other_candidates_but_only_when_it_is_one() {
        Entry bySlug = new Entry(UUID.randomUUID(), "Something else", "shared-name", Map.of());
        Entry byTitle = new Entry(UUID.randomUUID(), "Shared name", "another-slug", Map.of());
        List<Entry> both = List.of(bySlug, byTitle);

        assertThat(SeriesResolver.resolve("Shared Name", byTitle.id(), both)).isEqualTo(found(byTitle.id()));
        assertThat(SeriesResolver.resolve("Shared Name", QUEUES, both)).isEqualTo(new Result(Outcome.AMBIGUOUS, null));
    }

    @Test
    void the_candidates_are_every_series_the_name_could_mean_in_list_order() {
        Entry bySlug = new Entry(UUID.randomUUID(), "Something else", "shared-name", Map.of());
        Entry byTitle = new Entry(UUID.randomUUID(), "Shared name", "another-slug", Map.of());

        assertThat(SeriesResolver.candidates("shared name", List.of(QUEUES_SERIES, bySlug, byTitle)))
                .containsExactly(bySlug.id(), byTitle.id());
        assertThat(SeriesResolver.candidates("nothing like it", ALL)).isEmpty();
    }

    @Test
    void a_name_is_the_title_only_when_it_reads_the_same_as_the_title_or_a_translated_title() {
        assertThat(SeriesResolver.isTitleOf("Queues in practice", QUEUES_SERIES))
                .isTrue();
        assertThat(SeriesResolver.isTitleOf("Ten dich", TRANSLATED)).isTrue();
        assertThat(SeriesResolver.isTitleOf("queues in practice", QUEUES_SERIES))
                .isFalse();
        assertThat(SeriesResolver.isTitleOf("Cafe notes", CAFE_SERIES)).isFalse();
    }
}
