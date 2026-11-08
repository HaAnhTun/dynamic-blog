package com.blog.search.index;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.search.dto.Segment;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Sentinel -> {@link Segment} and stripping private-use characters ("highlight cannot inject HTML"): a segment is
 * data, the text is verbatim; no tag is ever generated, and a document cannot insert a highlight marker of its own.
 */
class SearchTextTest {

    private static final String PRE = String.valueOf(SearchText.HIGHLIGHT_PRE);
    private static final String POST = String.valueOf(SearchText.HIGHLIGHT_POST);

    @Test
    void sentinel_markers_become_matching_segments_and_rejoin_to_the_exact_text() {
        List<Segment> segments = SearchText.segments("Learn " + PRE + "Spring" + POST + " Boot " + PRE + "fast" + POST);
        assertThat(segments)
                .containsExactly(
                        new Segment("Learn ", false),
                        new Segment("Spring", true),
                        new Segment(" Boot ", false),
                        new Segment("fast", true));
        assertThat(SearchText.joined(segments)).isEqualTo("Learn Spring Boot fast");
        assertThat(SearchText.hasMatch(segments)).isTrue();
        assertThat(SearchText.segments("no match")).containsExactly(new Segment("no match", false));
        assertThat(SearchText.segments("")).isEmpty();
        assertThat(SearchText.segments(null)).isEmpty();
        assertThat(SearchText.hasMatch(null)).isFalse();
    }

    @Test
    void html_in_text_is_just_text_and_generates_no_tag() {
        String hostile = "<img src=x onerror=alert(1)>";
        List<Segment> segments = SearchText.segments("a " + PRE + hostile + POST + " <mark>b</mark> &lt;");
        assertThat(segments)
                .containsExactly(
                        new Segment("a ", false),
                        new Segment(hostile, true),
                        new Segment(" <mark>b</mark> &lt;", false));
        // No matching segment outside the sentinel-marked spot, even if the text contains <mark>.
        assertThat(segments.stream().filter(Segment::match).map(Segment::text)).containsExactly(hostile);
    }

    @Test
    void stray_marker_and_other_private_use_characters_produce_no_fake_matching_segment() {
        assertThat(SearchText.segments("a" + POST + "b")).containsExactly(new Segment("ab", false));
        assertThat(SearchText.segments("a" + PRE + "b")).containsExactly(new Segment("ab", false));
        assertThat(SearchText.segments(PRE + PRE + "x" + POST + POST)).containsExactly(new Segment("x", true));
        assertThat(SearchText.segments("a" + (char) 0xE123 + "b" + (char) 0xF8FF))
                .containsExactly(new Segment("ab", false));
        // Two adjacent matching regions merge into one segment.
        assertThat(SearchText.segments(PRE + "a" + POST + PRE + "b" + POST)).containsExactly(new Segment("ab", true));
    }

    @Test
    void strips_whole_range_u_e000_to_u_f8ff_and_keeps_every_other_character() {
        String forged = "Title " + PRE + "forged" + POST + " " + (char) 0xF8FF + "end" + (char) 0xE0FF;
        assertThat(SearchText.stripPrivateUse(forged)).isEqualTo("Title forged end");
        String emoji = "ok " + Character.toString(0x1F680) + " x " + (char) 0xDFFF + (char) 0xF900;
        assertThat(SearchText.stripPrivateUse(emoji)).isSameAs(emoji);
        assertThat(SearchText.stripPrivateUse(null)).isNull();
        assertThat(SearchText.stripPrivateUse(String.valueOf((char) 0xDFFF))).hasSize(1);
        assertThat(SearchText.stripPrivateUse(String.valueOf((char) 0xE000) + (char) 0xF8FF))
                .isEmpty();
    }
}
