package com.blog.common.text;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import com.blog.support.BlockArticle;
import java.time.Duration;
import org.junit.jupiter.api.Test;

class BlockMarkersTest {

    @Test
    void a_document_without_block_markers_is_returned_unchanged() {
        String markdown = "# Title\r\n\r\nText with a: colon and ::: inside.\n```\n:::callout\n```\n\n";
        assertThat(BlockMarkers.withoutMarkers(markdown)).isSameAs(markdown);
        assertThat(BlockMarkers.withoutMarkers(null)).isNull();
        assertThat(BlockMarkers.withoutMarkers("")).isEmpty();
    }

    @Test
    void marker_lines_are_dropped_and_the_text_inside_blocks_is_kept() {
        String markdown = """
                Before

                :::callout{type="warning" title="Careful"}
                Visible warning text.
                :::

                ::::steps{variant=grouped}
                :::step{title="First"}
                Do the first thing.
                :::
                ::::

                ::figure{src="assets/a.png" alt="An image"}
                """;
        assertThat(BlockMarkers.withoutMarkers(markdown))
                .isEqualTo("Before\n\nVisible warning text.\n\nDo the first thing.\n\n");
    }

    @Test
    void marker_lines_inside_a_code_fence_are_code() {
        String markdown = "```md\n:::callout{type=\"info\"}\ntext\n:::\n```\n";
        assertThat(BlockMarkers.withoutMarkers(markdown)).isSameAs(markdown);
    }

    @Test
    void a_diagram_keeps_only_its_title_and_alt_not_its_source() {
        String markdown = """
                :::diagram{type=mermaid title="Request flow" alt="Client calls the server"}
                graph TD
                  A[Client] --> B[Server]
                ```
                :::
                After the diagram.
                """;
        assertThat(BlockMarkers.withoutMarkers(markdown))
                .isEqualTo("Request flow\nClient calls the server\nAfter the diagram.\n");
    }

    @Test
    void a_diagram_is_closed_only_by_a_line_with_the_same_number_of_colons() {
        String markdown = """
                ::::steps
                :::step{title="One"}
                ::::diagram{type=mermaid}
                graph TD
                :::
                ::::
                Text after.
                :::
                ::::
                """;
        assertThat(BlockMarkers.withoutMarkers(markdown)).isEqualTo("Text after.\n");
    }

    @Test
    void an_unclosed_diagram_drops_the_rest_of_the_document() {
        assertThat(BlockMarkers.withoutMarkers("Intro\n:::diagram{type=mermaid}\ngraph TD\n"))
                .isEqualTo("Intro\n");
    }

    @Test
    void prose_that_only_looks_like_a_marker_is_kept() {
        // A bare "::" has no name and a closer needs three colons, so none of these lines is a marker: the text is
        // returned as is.
        String markdown = "::: not a marker because of the space and words\n:name in prose\n::\n";
        assertThat(BlockMarkers.withoutMarkers(markdown)).isSameAs(markdown);
    }

    @Test
    void a_crlf_document_loses_the_same_lines_as_the_lf_document() {
        String lf = BlockMarkers.withoutMarkers(BlockArticle.LF);
        String crlf = BlockMarkers.withoutMarkers(BlockArticle.CRLF);

        // The kept lines keep their carriage return; apart from the line endings the two are the same text.
        assertThat(crlf.replace("\r\n", "\n")).isEqualTo(lf);
        assertThat(crlf)
                .doesNotContain(":::")
                .doesNotContain("graph TD")
                .doesNotContain("Store")
                .contains("Request flow")
                .contains("Client calls the server")
                .contains("Do **not** run this twice.")
                .contains("```python title=\"hello.py\"\r\nprint(1)\r\n```")
                .contains("| a | b |\r\n| - | - |\r\n| 1 | 2 |");
    }

    @Test
    void a_crlf_diagram_closes_on_its_own_marker_and_a_crlf_fence_hides_marker_lines() {
        String diagram = "Before\r\n::::diagram{type=mermaid}\r\ngraph TD\r\n:::\r\nstill source\r\n::::\r\nAfter\r\n";
        String fenced = "```md\r\n:::callout{type=\"info\"}\r\ntext\r\n:::\r\n```\r\n";

        assertThat(BlockMarkers.withoutMarkers(diagram)).isEqualTo("Before\r\nAfter\r\n");
        assertThat(BlockMarkers.withoutMarkers(fenced)).isSameAs(fenced);
    }

    /**
     * A regex dot stops at U+0085 and U+2028, so a fence line that holds one failed late and retried every shorter run of
     * fence marks: quadratic in the length of the line. Such a line is still not a fence, as before.
     */
    @Test
    void a_long_fence_line_that_holds_a_line_separator_is_checked_in_bounded_time() {
        String line = "`".repeat(200_000) + (char) 0x85 + "y";
        String markdown = "::note\n" + line + "\n~~~" + (char) 0x2028 + "z\n";

        String text = assertTimeoutPreemptively(Duration.ofSeconds(2), () -> BlockMarkers.withoutMarkers(markdown));

        assertThat(text).isEqualTo(markdown.substring("::note\n".length()));
    }
}
