package com.blog.search.index;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import com.blog.fixtures.vi.SearchMarkdownVi;
import com.blog.support.BlockArticle;
import java.time.Duration;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * Markdown -> lowercase text for the index: strips the syntax, keeps the text of code and technical identifiers.
 */
class MarkdownTextTest {

    @Test
    void technical_identifiers_stay_intact_in_prose_and_in_code() {
        String markdown = """
                # Call `json.loads` in Python

                Use **snake_case** for variable names, like `max_retry_count`; C++ and C# do not count. Next.js 15 runs on
                Node.js, and __init__ in code: `__init__`. SpringBoot or Spring Boot are both fine.

                ```python
                import json
                data = json.loads(raw)  # C++? no
                def __init__(self): pass
                ```
                """;
        String text = MarkdownText.plain(markdown);
        assertThat(text)
                .contains(
                        "Call json.loads in Python",
                        "snake_case for variable names",
                        "max_retry_count",
                        "C++ and C# do not count",
                        "Next.js 15",
                        "Node.js",
                        "SpringBoot or Spring Boot",
                        "data = json.loads(raw)  # C++? no",
                        "def __init__(self): pass",
                        "in code: __init__.");
        assertThat(text).doesNotContain("```", "**", "`", "# Call");
    }

    @Test
    void vietnamese_diacritics_survive_syntax_stripping() {
        assertThat(MarkdownText.plain(SearchMarkdownVi.CALL_JSON_LOADS))
                .isEqualTo(SearchMarkdownVi.CALL_JSON_LOADS_PLAIN);
    }

    @Test
    void strips_block_and_inline_syntax_keeping_the_text_a_reader_sees() {
        String markdown = """
                ## Subheading ##
                > Quote in *italics* and _underscores_
                - Item one with [link](https://example.com/a_b "title")
                * [x] Task done
                1. Image: ![image alt](/media/a.jpg)
                ---
                | Column A | Column B |
                |---|:---:|
                | `a_b` | ~~removed~~ |
                <details><summary>Click</summary>Hidden</details>
                <!-- note -->
                Escape \\*star\\* and &amp; &lt;tag&gt; <https://example.com/x>
                [reference][ref]

                [ref]: https://example.com
                """;
        String text = MarkdownText.plain(markdown);
        assertThat(text)
                .contains(
                        "Subheading",
                        "Quote in italics and underscores",
                        "Item one with link",
                        "Task done",
                        "Image: image alt",
                        "Column A Column B",
                        "a_b removed",
                        "Click Hidden",
                        "Escape *star* and & <tag>",
                        "https://example.com/x",
                        "reference");
        assertThat(text)
                .doesNotContain(
                        "##",
                        "> Quote",
                        "](",
                        "https://example.com/a_b",
                        "/media/a.jpg",
                        "---",
                        "|",
                        "<details>",
                        "note",
                        "[ref]",
                        "[x]");
    }

    /**
     * The post page drops HTML comments and even the content of script and style (rehype-raw + rehype-sanitize): that
     * text must not enter the index, otherwise it would appear in Meilisearch snippets. Inside code they are plain
     * text.
     */
    @Test
    void text_the_post_page_does_not_show_stays_out_multiline_comment_script_style_even_unclosed() {
        String markdown = """
                Intro <!-- hidden one --> middle <!--
                legal note over several lines
                --> after comment
                <SCRIPT type="text/javascript">
                var secret = 1;
                </script> after script
                <style>.an { color: red }</style> after style
                Keep `<!-- in inline code -->` and tag <scripts>plain</scripts>
                ```html
                <!-- in code block -->
                ```
                End <!-- unclosed
                dropped to the end
                """;
        String text = MarkdownText.plain(markdown);
        assertThat(text)
                .contains(
                        "Intro",
                        "middle",
                        "after comment",
                        "after script",
                        "after style",
                        "Keep <!-- in inline code --> and tag plain",
                        "<!-- in code block -->",
                        "End");
        assertThat(text).doesNotContain("hidden one", "legal", "secret", "color", "unclosed", "dropped to the end");
    }

    @Test
    void operators_and_mid_word_underscores_are_not_emphasis() {
        assertThat(MarkdownText.plain("2 * 3 * 4 and a_b_c and x_ and snake_case_name"))
                .isEqualTo("2 * 3 * 4 and a_b_c and x and snake_case_name");
    }

    @Test
    void unclosed_code_block_is_kept_to_the_end_and_empty_input_is_empty() {
        assertThat(MarkdownText.plain("text\n~~~\n**unchanged**\n")).isEqualTo("text\n**unchanged**");
        assertThat(MarkdownText.plain(null)).isEmpty();
        assertThat(MarkdownText.plain("")).isEmpty();
        assertThat(MarkdownText.plain("a\r\n\r\n\r\nb")).isEqualTo("a\n\nb");
    }

    @Test
    void block_markers_and_attributes_are_not_indexed_but_the_text_of_every_block_is() {
        String markdown = """
                Intro text.

                :::callout{type="warning" title="Secret-attribute"}
                Callout **text** stays.
                :::

                ::::steps{variant=grouped}
                :::step{title="Step-attribute"}
                Step body stays.
                :::
                ::::

                :::details{title="Details-attribute" open}
                Details body stays.
                :::

                ::figure{src="assets/figure-source.png" alt="Figure-attribute"}

                :::diagram{type=mermaid title="Diagram title"}
                graph TD
                  Node1[Diagram-source] --> Node2
                :::

                :::code-tabs
                ```python title="a.py"
                print("tab code stays")
                ```
                :::
                """;
        String text = MarkdownText.plain(markdown);
        assertThat(text)
                .contains(
                        "Intro text.",
                        "Callout text stays.",
                        "Step body stays.",
                        "Details body stays.",
                        "Diagram title",
                        "print(\"tab code stays\")");
        assertThat(text)
                .doesNotContain(
                        "::",
                        "{",
                        "Secret-attribute",
                        "Step-attribute",
                        "Details-attribute",
                        "figure-source",
                        "Figure-attribute",
                        "graph TD",
                        "Diagram-source",
                        "warning");
    }

    @Test
    void a_document_without_blocks_is_indexed_as_before() {
        String markdown = "Time: 10:30 and a:: b\n\n::: not a marker\n\n```\n:::callout\n:::\n```\n";
        assertThat(MarkdownText.plain(markdown))
                .isEqualTo("Time: 10:30 and a:: b\n\n::: not a marker\n\n:::callout\n:::");
    }

    @Test
    void a_crlf_document_gives_the_same_text_as_the_lf_document_without_markers_or_diagram_source() {
        String lf = MarkdownText.plain(BlockArticle.LF);
        String crlf = MarkdownText.plain(BlockArticle.CRLF);

        assertThat(crlf).isEqualTo(lf).doesNotContain("\r");
        assertThat(crlf)
                .contains("Intro", "Do not run this twice.", "First.", "Second.", "print(1)", "echo 1")
                .contains("Request flow", "Hidden text.", "The end.")
                .doesNotContain(":::", "graph TD", "Store", "title=");
    }

    /**
     * A line an author can write so that a backtracking pattern burns CPU (Java regex matching cannot be interrupted) or
     * recurses once per character until the stack is gone: {@code prefix}, then {@code unit} repeated, then {@code suffix}
     * that makes the match fail only at the very end.
     */
    private record Hostile(String name, String prefix, String unit, String suffix) {

        String line(int size) {
            int repeats = Math.max(1, (size - prefix.length() - suffix.length()) / unit.length());
            return prefix + unit.repeat(repeats) + suffix;
        }

        @Override
        public String toString() {
            return name;
        }
    }

    /** U+0085: a line terminator for a regex dot, though not a line break for Markdown. */
    private static final String NEXT_LINE = String.valueOf((char) 0x85);

    private static Stream<Hostile> hostileLines() {
        return Stream.of(
                new Hostile("open bracket", "", "[x", ""),
                new Hostile("image open", "", "![", ""),
                new Hostile("reference link open", "", "[a", ""),
                new Hostile("reference link repeated", "", "![a][", ""),
                new Hostile("reference link then text", "", "[a][b", "x"),
                new Hostile("table divider spaces", "---", " ", "x"),
                new Hostile("table divider cells", "|", "---|", "x"),
                new Hostile("table divider spaces between cells", "", "| --- ", "x"),
                new Hostile("link destination", "[a](", "x", ""),
                new Hostile("link destination parentheses", "[a](", "()", ""),
                new Hostile("link destination groups", "[a](", "(a)", ""),
                new Hostile("link destination unclosed", "[a](", "x", " \"title"),
                new Hostile("data uri image", "![x](data:image/png;base64,", "A", ")"),
                new Hostile("thematic break", "", "-", "x"),
                new Hostile("thematic break with spaces", "", "* ", "x"),
                new Hostile("nested quote", "", "> ", "x"),
                new Hostile("heading close", "# a", " ", "b"),
                new Hostile("autolink open", "", "<http:a", ""),
                new Hostile("backticks only", "", "`", ""),
                new Hostile("mixed backtick runs", "", "`a``b```c````", ""),
                new Hostile("inline code with comment open", "", "`<!--`", ""),
                new Hostile("comment open", "", "<!--", ""),
                new Hostile("emphasis open", "", "*a ", ""),
                new Hostile("html tag open", "", "<a x", ""),
                new Hostile("fence then line separator", "", "`", NEXT_LINE + "y"),
                new Hostile("fence then line separator after a block marker", "::note\n", "~", NEXT_LINE + "y"),
                new Hostile("reference definition then line separator", "[a]: ", "x", " y" + NEXT_LINE + "z"));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("hostileLines")
    void a_hostile_line_is_processed_in_bounded_time_without_error(Hostile hostile) {
        String line = hostile.line(200_000);

        String text = assertTimeoutPreemptively(Duration.ofSeconds(2), () -> MarkdownText.plain(line));

        assertThat(text).isNotNull();
    }

    /**
     * The same lines at the longest length that still gets Markdown processing, one per line of a document of the largest
     * size a post may have: the cost of a line is capped, so the cost of the document is capped too.
     */
    @ParameterizedTest(name = "{0}")
    @MethodSource("hostileLines")
    void a_document_of_hostile_lines_at_the_line_cap_is_processed_in_bounded_time(Hostile hostile) {
        String line = hostile.line(MarkdownText.MAX_LINE_CHARS);
        assertThat(line.length()).isLessThanOrEqualTo(MarkdownText.MAX_LINE_CHARS);
        String document = (line + "\n").repeat(500_000 / line.length());

        String text = assertTimeoutPreemptively(Duration.ofSeconds(10), () -> MarkdownText.plain(document));

        assertThat(text).isNotNull();
    }

    @Test
    void a_line_over_the_cap_is_kept_as_text_with_its_markup_untouched() {
        String words = "word ".repeat(3_000);

        String text = MarkdownText.plain(words + "**bold** [link](https://example.com/x) tail\nnext **line**");

        assertThat(text).startsWith("word word").contains("**bold** [link](https://example.com/x) tail");
        assertThat(text).endsWith("next line");
    }

    @Test
    void hidden_text_is_dropped_from_a_line_over_the_cap_too() {
        String words = "word ".repeat(3_000);

        String text = MarkdownText.plain(words + "<!-- secret --> tail <script>var hidden = 1;</script> end");

        assertThat(text).contains("word word", "tail", "end").doesNotContain("secret", "hidden", "<!--", "script");
    }

    @Test
    void an_unclosed_comment_on_a_line_over_the_cap_still_drops_the_following_lines() {
        String words = "word ".repeat(3_000);

        String text = MarkdownText.plain(words + "<!-- note\nstill hidden\n--> shown");

        assertThat(text).contains("word word", "shown").doesNotContain("note", "still hidden");
    }

    /** Output of the patterns before they were made possessive and bounded: normal Markdown must give the same text. */
    private static Stream<Arguments> unchangedByTheBoundedPatterns() {
        return Stream.of(
                Arguments.of(
                        "See [a](https://x.org/f_(b) \"t\") and ![i](p.png \"x y\") and [r][ref] and [e]() end",
                        "See a and i and r and e end"),
                Arguments.of("[a](url with space) [b](x\"y) [c](u (n)) [d](", "[a](url with space) b [c](u (n)) [d]("),
                Arguments.of("A [one][1] B ![two][] C [3]", "A one B two C [3]"),
                Arguments.of("Use ``a`b`` and `c` here", "Use a`b and c here"),
                Arguments.of("Keep `<!-- x -->` and `**y**` ok", "Keep <!-- x --> and **y** ok"),
                Arguments.of("x `y", "x `y"),
                Arguments.of("* * *", ""),
                Arguments.of("___", ""),
                Arguments.of("- - -", ""),
                Arguments.of("-- -", ""),
                Arguments.of("--- x", "--- x"),
                Arguments.of("> > nested quote", "nested quote"),
                Arguments.of(">> tight", "tight"),
                Arguments.of("|:--|--:|", ":-- --:"),
                Arguments.of(" --- | --- ", ""),
                Arguments.of("---|---", ""),
                Arguments.of("|---", ""),
                Arguments.of("--", "--"),
                Arguments.of("---x", "---x"),
                Arguments.of("| --- | x |", "--- x"),
                Arguments.of(":---:", ""),
                Arguments.of("## Title ##   ", "Title"),
                Arguments.of("# a #b", "a #b"),
                Arguments.of("# a  ", "a"),
                Arguments.of("## a # #", "a #"),
                Arguments.of(
                        "<https://x.org/a?b=c> and <mailto:a@b.c> and <http:>",
                        "https://x.org/a?b=c and mailto:a@b.c and <http:>"),
                Arguments.of("[ref]: https://x.org \"title\"", ""),
                Arguments.of("[a]:", "[a]:"),
                Arguments.of("  [b]:\thttp://u  more words", ""));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("unchangedByTheBoundedPatterns")
    void normal_markdown_gives_the_same_text_as_before_the_patterns_were_bounded(String markdown, String expected) {
        assertThat(MarkdownText.plain(markdown)).isEqualTo(expected);
    }

    @Test
    void a_link_text_over_the_bound_stays_as_written_and_one_at_the_bound_is_stripped() {
        String atBound = "a".repeat(300);
        String overBound = "a".repeat(301);

        assertThat(MarkdownText.plain("[" + atBound + "](https://example.com/x)"))
                .isEqualTo(atBound);
        assertThat(MarkdownText.plain("[" + overBound + "](https://example.com/x)"))
                .isEqualTo("[" + overBound + "](https://example.com/x)");
    }

    @Test
    void a_data_uri_image_keeps_its_alt_text_instead_of_overflowing_the_stack() {
        String markdown = "before ![diagram](data:image/png;base64," + "A".repeat(8_000) + ") after";

        assertThat(MarkdownText.plain(markdown)).isEqualTo("before diagram after");
    }
}
