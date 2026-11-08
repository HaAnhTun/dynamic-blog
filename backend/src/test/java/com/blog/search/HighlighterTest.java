package com.blog.search;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

import com.blog.fixtures.vi.SearchHighlightVi;
import com.blog.search.dto.Segment;
import com.blog.search.service.Highlighter;
import java.text.Normalizer;
import java.util.List;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * The Java port of {@code frontend/lib/highlight.ts} must highlight exactly like the TS version: the cases below are
 * copied from {@code highlight.test.ts}, same strings, same results.
 */
class HighlighterTest {

    private static final boolean PREFIX = true;

    @Test
    void matches_without_diacritics_case_insensitively_and_folds_d_stroke_to_d() {
        assertThat(Highlighter.segments(SearchHighlightVi.LEARN_JAVA_FROM_SCRATCH, "hoc", false))
                .containsExactly(
                        new Segment(SearchHighlightVi.LEARN_CAP, true),
                        new Segment(SearchHighlightVi.JAVA_FROM_SCRATCH_REST, false));
        assertThat(marked(Highlighter.segments(SearchHighlightVi.WAY_HOME, "duong", false)))
                .containsExactly(SearchHighlightVi.ROAD_CAP, SearchHighlightVi.ROAD);
        assertThat(marked(Highlighter.segments(
                        SearchHighlightVi.QUEUE_UPPER_AND_LOWER, SearchHighlightVi.QUEUE_QUERY, false)))
                .containsExactly(
                        SearchHighlightVi.QUEUE_UPPER_1,
                        SearchHighlightVi.WAIT_UPPER,
                        SearchHighlightVi.QUEUE_LOWER_1,
                        SearchHighlightVi.WAIT_LOWER);
    }

    @Test
    void nfd_text_highlight_includes_combining_marks_of_last_letter_and_rejoins_to_original() {
        String text = nfd(SearchHighlightVi.LESSON_RAISE_ISSUE);
        List<Segment> segments = Highlighter.segments(text, "hoc dat", false);
        assertThat(joined(segments)).isEqualTo(text);
        assertThat(marked(segments)).containsExactly(nfd(SearchHighlightVi.LEARN), nfd(SearchHighlightVi.RAISE_CAP));
        // No combining mark is left orphaned at the start of an unhighlighted segment.
        assertThat(segments)
                .filteredOn(segment -> !segment.match())
                .noneMatch(segment -> Character.getType(segment.text().codePointAt(0)) == Character.NON_SPACING_MARK);

        String middle = nfd(SearchHighlightVi.THEY_READ);
        List<Segment> inMiddle = Highlighter.segments(middle, "ho", false);
        assertThat(marked(inMiddle)).containsExactly(nfd(SearchHighlightVi.THEY_CAP));
        assertThat(inMiddle.get(1).text()).isEqualTo(nfd(SearchHighlightVi.READ_REST));
        String end = nfd(SearchHighlightVi.READ_MORE_ABOUT_THEM);
        assertThat(marked(Highlighter.segments(end, "ho", false))).containsExactly(nfd(SearchHighlightVi.THEY));
        assertThat(joined(Highlighter.segments(end, "ho", false))).isEqualTo(end);
    }

    @Test
    void nfd_query_matches_nfc_text_and_vice_versa() {
        assertThat(marked(Highlighter.segments(SearchHighlightVi.LESSON, nfd(SearchHighlightVi.LEARN), false)))
                .containsExactly(SearchHighlightVi.LEARN);
        assertThat(marked(Highlighter.segments(nfd(SearchHighlightVi.LESSON), SearchHighlightVi.LEARN, false)))
                .containsExactly(nfd(SearchHighlightVi.LEARN));
    }

    @Test
    void default_matches_whole_words_only_like_postgres() {
        assertThat(marked(Highlighter.segments("hocthuat and queues", "hoc queue", false)))
                .isEmpty();
        assertThat(marked(Highlighter.segments(SearchHighlightVi.STUDENT_STUDIES_LESSON, "hoc", false)))
                .containsExactly(SearchHighlightVi.LEARN_CAP, SearchHighlightVi.LEARN);
        assertThat(marked(Highlighter.segments(SearchHighlightVi.THEY_STUDY, "ho", false)))
                .containsExactly(SearchHighlightVi.THEY_CAP);
        assertThat(marked(Highlighter.segments("aab ab", "ab", false))).containsExactly("ab");
        assertThat(marked(Highlighter.segments("Version V6 and V60", "v6", false)))
                .containsExactly("V6");
        // Punctuation and hyphens are word boundaries.
        String punctuated = SearchHighlightVi.PUNCTUATED_SCHOOL;
        assertThat(marked(Highlighter.segments(punctuated, "hoc", false)))
                .containsExactly(SearchHighlightVi.LEARN, SearchHighlightVi.LEARN, SearchHighlightVi.LEARN);
        assertThat(joined(Highlighter.segments(punctuated, "hoc", false))).isEqualTo(punctuated);
    }

    @Test
    void multiple_keywords_highlight_in_sentence_order_and_repeated_keyword_is_not_highlighted_twice() {
        assertThat(Highlighter.segments(SearchHighlightVi.JOB_QUEUE_SENTENCE, "queue gcp hang", false))
                .containsExactly(
                        new Segment(SearchHighlightVi.QUEUE_CAP, true),
                        new Segment(SearchHighlightVi.WAIT_JOB_ON, false),
                        new Segment("GCP", true),
                        new Segment(SearchHighlightVi.WHEN_NEEDED, false),
                        new Segment("queue", true));
        assertThat(Highlighter.segments("queue queue", "queue QUEUE queue", false))
                .containsExactly(new Segment("queue", true), new Segment(" ", false), new Segment("queue", true));
    }

    @ParameterizedTest
    @ValueSource(strings = {"c++", "(", "[", "$", "\\", ".*", "a.*b", "(?<x>", "[^]", "\\b", "|", "^$"})
    void regex_special_characters_in_query_do_not_throw_or_match_wildly(String query) {
        String text = "Write C++ (and $ [x] \\ .*) for newcomers";
        assertThatCode(() -> Highlighter.segments(text, query, false)).doesNotThrowAnyException();
        List<Segment> segments = Highlighter.segments(text, query, false);
        assertThat(joined(segments)).isEqualTo(text);
        assertThat(marked(segments)).allMatch(part -> part.matches("[\\p{L}\\p{N}]+"));
    }

    @Test
    void c_plus_plus_is_keyword_c_and_query_without_words_is_one_unhighlighted_segment() {
        assertThat(Highlighter.segments("Write C++ for newcomers", "c++", false))
                .containsExactly(
                        new Segment("Write ", false), new Segment("C", true), new Segment("++ for newcomers", false));
        for (String query : List.of("", "   ", "!@#$%^&*()", "—")) {
            assertThat(Highlighter.segments(SearchHighlightVi.LESSON, query, false))
                    .as(query)
                    .containsExactly(new Segment(SearchHighlightVi.LESSON, false));
        }
        assertThat(Highlighter.segments("", "hoc", false)).isEmpty();
    }

    @Test
    void non_bmp_characters_do_not_shift_positions_and_html_is_kept_verbatim() {
        String rocket = SearchHighlightVi.ROCKET_LEARN_FAST;
        assertThat(marked(Highlighter.segments(rocket, "hoc", false)))
                .containsExactly(SearchHighlightVi.LEARN_CAP, SearchHighlightVi.LEARN);
        assertThat(joined(Highlighter.segments(rocket, "hoc", false))).isEqualTo(rocket);
        // A word right after an emoji (a surrogate pair) is still a word start.
        assertThat(marked(Highlighter.segments(SearchHighlightVi.ROCKET_LEARN, "hoc", false)))
                .containsExactly(SearchHighlightVi.LEARN);

        String html = SearchHighlightVi.IMG_HTML_LEARN;
        List<Segment> segments = Highlighter.segments(html, "hoc img", false);
        assertThat(joined(segments)).isEqualTo(html);
        assertThat(marked(segments)).containsExactly("img", SearchHighlightVi.LEARN);
    }

    @Test
    void prefix_match_highlights_typed_part_at_word_start_including_unaccented_and_nfd() {
        assertThat(marked(Highlighter.segments("Spring Boot and inspring", "spri", PREFIX)))
                .containsExactly("Spri");
        assertThat(marked(Highlighter.segments("Spring Boot", "spri", false))).isEmpty();

        String text = nfd(SearchHighlightVi.ROAD_STUDY);
        List<Segment> segments = Highlighter.segments(text, "duo ho", PREFIX);
        assertThat(joined(segments)).isEqualTo(text);
        assertThat(marked(segments).stream().map(part -> Normalizer.normalize(part, Normalizer.Form.NFC)))
                .containsExactly(SearchHighlightVi.ROAD_PREFIX, SearchHighlightVi.THEY);

        // Two overlapping keywords are not highlighted twice.
        List<Segment> overlapping = Highlighter.segments("Spring", "sp spring", PREFIX);
        assertThat(joined(overlapping)).isEqualTo("Spring");
        assertThat(marked(overlapping)).containsExactly("Sp");
    }

    @Test
    void matchesQuery_requires_all_words_and_no_words_means_no_match() {
        assertThat(Highlighter.matchesQuery(SearchHighlightVi.SYSTEM_ARCHITECTURE, "kien he", PREFIX))
                .isTrue();
        assertThat(Highlighter.matchesQuery(SearchHighlightVi.SYSTEM_ARCHITECTURE, "kien mang", PREFIX))
                .isFalse();
        assertThat(Highlighter.matchesQuery(SearchHighlightVi.ARCHITECTURE, "kie", false))
                .isFalse();
        assertThat(Highlighter.matchesQuery(SearchHighlightVi.ARCHITECTURE, "kien", false))
                .isTrue();
        assertThat(Highlighter.matchesQuery(SearchHighlightVi.ARCHITECTURE, " ,. ", PREFIX))
                .isFalse();
        assertThat(Highlighter.matchesQuery(SearchHighlightVi.ARCHITECTURE, "kien tr", PREFIX))
                .isTrue();
    }

    private static String nfd(String text) {
        return Normalizer.normalize(text, Normalizer.Form.NFD);
    }

    private static List<String> marked(List<Segment> segments) {
        return segments.stream().filter(Segment::match).map(Segment::text).toList();
    }

    private static String joined(List<Segment> segments) {
        return segments.stream().map(Segment::text).collect(Collectors.joining());
    }
}
