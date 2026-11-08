package com.blog.search.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.fixtures.vi.SearchVi;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The pure part of the Meilisearch provider: each group's filter built only from constants and checked slugs, query
 * syntax stripping that Postgres lacks, and the deep-page cap. The rest runs on a real container in MeiliSearchIT.
 */
class MeiliSearchProviderTest {

    private static SearchRequest post(String category, List<String> tags, String series, int page, int size) {
        return new SearchRequest("spring", SearchType.POST, 10, page, size, category, tags, series);
    }

    @Test
    void each_group_filter_is_an_and_array_of_constants_and_slug() {
        assertThat(MeiliSearchProvider.filter(
                        post("java", List.of("spring", "boot"), "loat-bai", 0, 10), SearchType.POST))
                .containsExactly(
                        "type = \"post\"",
                        "categorySlug = \"java\"",
                        "seriesSlug = \"loat-bai\"",
                        "tagSlugs = \"spring\"",
                        "tagSlugs = \"boot\"");
        SearchRequest all = new SearchRequest("spring", null, 5, 0, 10, null, List.of(), null);
        assertThat(MeiliSearchProvider.filter(all, SearchType.TOPIC))
                .containsExactly("type IN [\"category\", \"tag\"]");
        assertThat(MeiliSearchProvider.filter(all, SearchType.CASE_STUDY)).containsExactly("type = \"case-study\"");
        assertThat(MeiliSearchProvider.filter(all, SearchType.AUTHOR)).containsExactly("type = \"author\"");
        assertThat(MeiliSearchProvider.filter(all, SearchType.PAGE)).containsExactly("type = \"page\"");
        assertThat(MeiliSearchProvider.filter(all, SearchType.SERIES)).containsExactly("type = \"series\"");
    }

    @Test
    void language_adds_an_or_not_exists_filter_to_every_group_and_none_without_it() {
        SearchRequest english = new SearchRequest("spring", null, 5, 0, 10, null, List.of(), null, "en");
        String language = "(language = \"en\" OR language NOT EXISTS)";
        for (SearchType type : SearchType.values()) {
            assertThat(MeiliSearchProvider.filter(english, type)).last().isEqualTo(language);
        }
        SearchRequest posts = new SearchRequest("spring", SearchType.POST, 10, 0, 10, "java", List.of(), null, "vi");
        assertThat(MeiliSearchProvider.filter(posts, SearchType.POST))
                .containsExactly(
                        "type = \"post\"", "categorySlug = \"java\"", "(language = \"vi\" OR language NOT EXISTS)");
        SearchRequest any = new SearchRequest("spring", null, 5, 0, 10, null, List.of(), null);
        assertThat(MeiliSearchProvider.filter(any, SearchType.POST)).containsExactly("type = \"post\"");
    }

    @Test
    void query_drops_phrase_and_exclusion_syntax_but_keeps_every_word() {
        assertThat(MeiliSearchProvider.queryText("\"spring boot\" -java")).isEqualTo(" spring boot  java");
        assertThat(MeiliSearchProvider.queryText("-x --y a-b c++ c# json.loads"))
                .isEqualTo("x y a-b c++ c# json.loads");
        assertThat(MeiliSearchProvider.queryText(SearchVi.MACHINE_LEARNING)).isEqualTo(SearchVi.MACHINE_LEARNING);
    }

    @Test
    void query_without_letters_or_digits_matches_nothing_and_blank_q_is_filter_only() {
        for (String q : List.of("!!", "--", "+", "?!", " - ")) {
            assertThat(MeiliSearchProvider.nothingToMatch(new SearchRequest(q, null, 5, 0, 10, null, List.of(), null)))
                    .as(q)
                    .isTrue();
        }
        for (String q : List.of("C++", "c#", "-x", "2", SearchVi.LEARN, "", "!a")) {
            assertThat(MeiliSearchProvider.nothingToMatch(new SearchRequest(q, null, 5, 0, 10, null, List.of(), null)))
                    .as(q)
                    .isFalse();
        }
    }

    @Test
    void posts_page_beyond_first_1000_results_is_a_deep_page() {
        assertThat(MeiliSearchProvider.beyondHitCap(post(null, List.of(), null, 99, 10)))
                .isFalse();
        assertThat(MeiliSearchProvider.beyondHitCap(post(null, List.of(), null, 100, 10)))
                .isTrue();
        assertThat(MeiliSearchProvider.beyondHitCap(post(null, List.of(), null, 19, 50)))
                .isFalse();
        assertThat(MeiliSearchProvider.beyondHitCap(post(null, List.of(), null, 20, 50)))
                .isTrue();
        assertThat(MeiliSearchProvider.beyondHitCap(post(null, List.of(), null, Integer.MAX_VALUE / 100, 50)))
                .isTrue();
        // Not the posts tab: no pagination, never deep.
        assertThat(MeiliSearchProvider.beyondHitCap(new SearchRequest("x", null, 5, 500, 50, null, List.of(), null)))
                .isFalse();
    }
}
