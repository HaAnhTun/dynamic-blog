package com.blog.postimport.format;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.postimport.format.PostPackageRefs.Finding;
import com.blog.postimport.format.PostPackageRefs.Kind;
import com.blog.postimport.format.PostPackageRefs.Ref;
import com.blog.postimport.format.PostPackageRefs.Scan;
import com.blog.support.BlockArticle;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

/** Where the body of an article names a file, what in it is unsafe, and how the named places are rewritten. */
class PostPackageRefsTest {

    private static List<String> raws(Scan scan) {
        return scan.refs().stream().map(Ref::raw).toList();
    }

    // --- References -------------------------------------------------------------------------------------------

    @Test
    void images_links_definitions_and_figures_are_references_with_their_line() {
        String body = """
                Intro ![First image](assets/a.png "A title") and [a link](assets/b.pdf).

                [label]: assets/c.png
                ![nested [brackets]](<assets/with space.png>)

                :::figure{src="assets/d.png" alt="Fig D" caption=x}
                :::

                ::figure{src=assets/e.png alt="Fig E"}
                """;

        Scan scan = PostPackageRefs.scan(body);

        assertThat(raws(scan))
                .containsExactly(
                        "assets/a.png",
                        "assets/b.pdf",
                        "assets/c.png",
                        "assets/with space.png",
                        "assets/d.png",
                        "assets/e.png");
        assertThat(scan.refs()).extracting(Ref::line).containsExactly(1, 1, 3, 4, 6, 9);
        assertThat(scan.refs()).extracting(Ref::image).containsExactly(true, false, false, true, true, true);
        assertThat(scan.refs().get(0).alt()).isEqualTo("First image");
        assertThat(scan.refs().get(3).alt()).isEqualTo("nested [brackets]");
        assertThat(scan.refs().get(4).alt()).isEqualTo("Fig D");
        assertThat(scan.refs().get(5).alt()).isEqualTo("Fig E");
        for (Ref ref : scan.refs()) {
            assertThat(body.substring(ref.start(), ref.end())).isEqualTo(ref.raw());
        }
    }

    @Test
    void the_images_of_a_gallery_are_references_like_any_other() {
        String body = ":::gallery{columns=2}\n![One](assets/1.png)\n![Two](assets/2.png)\n:::\n";

        assertThat(raws(PostPackageRefs.scan(body))).containsExactly("assets/1.png", "assets/2.png");
    }

    @Test
    void an_image_inside_a_link_gives_both_places() {
        Scan scan = PostPackageRefs.scan("[![alt](assets/a.png)](https://example.org/x)\n");

        assertThat(raws(scan)).containsExactly("assets/a.png", "https://example.org/x");
        assertThat(scan.refs()).extracting(Ref::image).containsExactly(true, false);
    }

    @Test
    void fenced_code_inline_code_and_text_without_a_destination_name_nothing() {
        String body = """
                ```markdown
                ![in a fence](assets/fenced.png)
                ```

                ~~~
                ![in a tilde fence](assets/tilde.png)
                ~~~

                Inline `![in code](assets/inline.png)` and ``![in double](assets/double.png)``.
                Not a link [text] (assets/space.png) and [text]: no destination here ![x]() or ![y](assets/open.png
                ![real](assets/real.png)
                """;

        assertThat(raws(PostPackageRefs.scan(body))).containsExactly("assets/real.png");
    }

    @Test
    void a_longer_fence_is_closed_only_by_a_fence_at_least_as_long() {
        String body =
                "````\n```\n![in](assets/in.png)\n```\n![still in](assets/still.png)\n````\n![out](assets/out.png)\n";

        assertThat(raws(PostPackageRefs.scan(body))).containsExactly("assets/out.png");
    }

    // --- Resolving --------------------------------------------------------------------------------------------

    @ParameterizedTest
    @CsvSource({
        "assets/a.png, assets/a.png",
        "./assets/a.png, assets/a.png",
        "assets/sub/../a.png, assets/a.png",
        "assets/a.png#800x600, assets/a.png",
        "assets/a.png?raw=1, assets/a.png",
        "assets/my%20image.png, assets/my image.png",
        "assets//a.png, assets/a.png"
    })
    void a_relative_path_is_normalized(String raw, String path) {
        PostPackageRefs.Target target = PostPackageRefs.resolve(raw);

        assertThat(target.kind()).isEqualTo(Kind.LOCAL);
        assertThat(target.path()).isEqualTo(path);
    }

    @Test
    void a_path_is_compared_in_nfc_and_a_bad_percent_sequence_is_left_as_it_is() {
        assertThat(PostPackageRefs.resolve("assets/cafe\u0301.png").path()).isEqualTo("assets/caf\u00e9.png");
        assertThat(PostPackageRefs.resolve("assets/caf%C3%A9.png").path()).isEqualTo("assets/caf\u00e9.png");
        assertThat(PostPackageRefs.resolve("assets/100%.png").path()).isEqualTo("assets/100%.png");
        assertThat(PostPackageRefs.resolve("assets/%FF.png").path()).isEqualTo("assets/%FF.png");
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "https://example.org/a.png",
                "http://example.org/a.png",
                "mailto:someone@example.org",
                "data:image/png;base64,AAAA",
                "/media/x.png",
                "//cdn.example.org/a.png",
                "#section",
                ""
            })
    void a_url_a_site_path_or_a_fragment_names_nothing_in_the_package(String raw) {
        assertThat(PostPackageRefs.resolve(raw).kind()).isEqualTo(Kind.REMOTE);
    }

    @Test
    void a_path_that_climbs_out_of_the_package_escapes() {
        assertThat(PostPackageRefs.resolve("../a.png").kind()).isEqualTo(Kind.ESCAPES);
        assertThat(PostPackageRefs.resolve("assets/../../a.png").kind()).isEqualTo(Kind.ESCAPES);
    }

    // --- Unsafe content ---------------------------------------------------------------------------------------

    @ParameterizedTest
    @CsvSource(
            delimiter = '|',
            value = {
                "<script>alert(1)</script>|script elements are not allowed",
                "<SCRIPT src=x>|script elements are not allowed",
                "text <style>p{}</style>|style elements are not allowed",
                "<iframe src=x></iframe>|iframe elements are not allowed",
                "<object data=x></object>|object elements are not allowed",
                "<embed src=x>|embed elements are not allowed",
                "[x](javascript:alert(1))|javascript: URLs are not allowed",
                "<a href=\"#\" onclick=\"x()\">x</a>|inline event handler attributes (onclick and the like) are not allowed",
                "<img src=x onerror=x()>|inline event handler attributes (onclick and the like) are not allowed",
                "<img src=\"x\"onload = y>|inline event handler attributes (onclick and the like) are not allowed"
            })
    void unsafe_content_is_a_finding_with_a_fixed_sentence_and_its_line(String line, String message) {
        Scan scan = PostPackageRefs.scan("First line\n" + line + "\n");

        assertThat(scan.unsafe()).containsExactly(new Finding(2, message));
    }

    @Test
    void what_a_tutorial_shows_in_code_is_not_unsafe() {
        String body = """
                ```html
                <script>alert(1)</script>
                <a onclick="x()">x</a>
                ```

                Use `<script>` and `<iframe>` with care, and an `onclick=` attribute never.
                """;

        assertThat(PostPackageRefs.scan(body).unsafe()).isEmpty();
    }

    @Test
    void prose_that_only_looks_like_a_tag_or_a_handler_is_not_unsafe() {
        String body = "A <scripts> tag is not a script. Once x = 1, then List<String> onChange = 2 is fine.\n"
                + "Also <b>bold</b> and a <a href=\"https://example.org\">link</a>.\n";

        assertThat(PostPackageRefs.scan(body).unsafe()).isEmpty();
    }

    @Test
    void a_tag_that_spans_lines_is_read_as_one_tag() {
        Scan scan = PostPackageRefs.scan("<img\n  src=\"x\"\n  onerror=\"y()\">\n");

        assertThat(scan.unsafe()).extracting(Finding::line).containsExactly(3);
    }

    @Test
    void a_handler_at_the_start_of_a_line_inside_a_tag_is_unsafe_and_the_same_words_in_prose_are_not() {
        Scan inTag = PostPackageRefs.scan("<img src=x\nonerror=alert(1)>\n");
        Scan prose = PostPackageRefs.scan("A handler such as\nonerror=alert(1) is only prose here.\n");

        assertThat(inTag.unsafe()).containsExactly(new Finding(2, PostPackageRefs.EVENT_HANDLER));
        assertThat(prose.unsafe()).isEmpty();
    }

    @Test
    void an_opening_fence_whose_info_string_holds_a_backtick_does_not_hide_what_follows() {
        Scan scan = PostPackageRefs.scan("``` a`b\n<script>alert(1)</script>\n```\n");
        Scan tilde = PostPackageRefs.scan("~~~ a`b\n<script>alert(1)</script>\n~~~\n");
        Scan real = PostPackageRefs.scan("```js\n<script>alert(1)</script>\n```\n");

        assertThat(scan.unsafe()).contains(new Finding(2, PostPackageRefs.SCRIPT));
        assertThat(tilde.unsafe()).isEmpty();
        assertThat(real.unsafe()).isEmpty();
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "[x](&#106;avascript:alert(1))",
                "[x](&#x6A;avascript:alert(1))",
                "[x](java&#9;script:alert(1))",
                "[x](&#74;AVASCRIPT:alert(1))",
                "[x](java\tscript:alert(1))"
            })
    void a_script_url_written_with_character_references_or_a_tab_is_still_a_script_url(String line) {
        Scan scan = PostPackageRefs.scan("First\n" + line + "\n");

        assertThat(scan.unsafe()).containsExactly(new Finding(2, PostPackageRefs.JAVASCRIPT_URL));
    }

    @Test
    void character_references_that_do_not_spell_a_script_url_are_left_alone() {
        String body = "Fish &amp; chips, &#169; 2026, &#x1F600; and &#999999999; and &#; and &#x; and & alone.\n"
                + "[x](https://example.org/a&#47;b) and a java script: remark.\n";

        assertThat(PostPackageRefs.scan(body).unsafe()).isEmpty();
    }

    @Test
    void a_very_long_line_of_open_tags_is_scanned_in_linear_time() {
        String body = "<a ".repeat(100_000) + "\n";

        long start = System.nanoTime();
        PostPackageRefs.scan(body);

        assertThat((System.nanoTime() - start) / 1_000_000).isLessThan(2_000);
    }

    @ParameterizedTest
    @ValueSource(strings = {"[](", "[](<", "![a](b \"", "](((a", "`` ` ``` `", "![", "[a]: <"})
    void a_line_of_thousands_of_unfinished_links_costs_no_more_than_a_scan_of_the_line(String piece) {
        String body = piece.repeat(80_000) + "\n" + piece.repeat(80_000);

        long start = System.nanoTime();
        PostPackageRefs.scan(body);

        assertThat((System.nanoTime() - start) / 1_000_000).isLessThan(3_000);
    }

    @Test
    void a_very_long_line_of_character_references_is_scanned_in_linear_time() {
        String body = "&#".repeat(200_000) + "\n" + "&#x1".repeat(100_000) + "\n";

        long start = System.nanoTime();
        PostPackageRefs.scan(body);

        assertThat((System.nanoTime() - start) / 1_000_000).isLessThan(2_000);
    }

    // --- Rewriting --------------------------------------------------------------------------------------------

    @Test
    void a_crlf_body_has_the_references_and_lines_of_the_lf_body() {
        Scan lf = PostPackageRefs.scan(BlockArticle.LF);
        Scan crlf = PostPackageRefs.scan(BlockArticle.CRLF);

        assertThat(raws(crlf)).containsExactly("assets/a.png", "assets/b.png", "assets/c.png");
        assertThat(raws(crlf)).isEqualTo(raws(lf));
        assertThat(crlf.refs())
                .extracting(Ref::line)
                .isEqualTo(lf.refs().stream().map(Ref::line).toList());
        assertThat(crlf.refs()).extracting(Ref::alt).containsExactly("First", "Second", "A chart");
        assertThat(crlf.unsafe()).isEmpty();
        for (Ref ref : crlf.refs()) {
            assertThat(BlockArticle.CRLF.substring(ref.start(), ref.end())).isEqualTo(ref.raw());
        }
    }

    @Test
    void a_crlf_body_skips_fenced_code_and_reports_unsafe_content_on_the_right_line() {
        String body = "Intro\r\n\r\n```md\r\n![shown](assets/shown.png)\r\n```\r\n\r\n![used](assets/used.png)\r\n\r\n"
                + "<script>alert(1)</script>\r\n";

        Scan scan = PostPackageRefs.scan(body);

        assertThat(raws(scan)).containsExactly("assets/used.png");
        assertThat(scan.refs()).extracting(Ref::line).containsExactly(7);
        assertThat(scan.unsafe()).extracting(Finding::line).containsExactly(9);
    }

    @Test
    void rewriting_a_crlf_body_keeps_its_line_endings() {
        Scan scan = PostPackageRefs.scan(BlockArticle.CRLF);
        Map<Ref, String> replacements = new HashMap<>();
        for (Ref ref : scan.refs()) {
            replacements.put(ref, "/media/11111111-1111-1111-1111-111111111111.png#10x20");
        }

        String rewritten = PostPackageRefs.rewrite(BlockArticle.CRLF, replacements);

        assertThat(rewritten)
                .doesNotContain("assets/")
                .contains("![First](/media/11111111-1111-1111-1111-111111111111.png#10x20)\r\n")
                .contains(
                        "::figure{src=\"/media/11111111-1111-1111-1111-111111111111.png#10x20\" alt=\"A chart\"}\r\n");
        assertThat(rewritten.replace("\r\n", "")).doesNotContain("\n").doesNotContain("\r");
    }

    @Test
    void only_the_named_places_are_replaced_and_everything_else_is_kept() {
        String body =
                "Before ![A](assets/a.png \"T\") and [B](assets/b.png) after\n\n:::figure{src=\"assets/a.png\" alt=\"x\"}\n:::\n";
        Scan scan = PostPackageRefs.scan(body);
        Map<Ref, String> replacements = new HashMap<>();
        for (Ref ref : scan.refs()) {
            if (ref.raw().equals("assets/a.png")) {
                replacements.put(ref, "/media/11111111-1111-1111-1111-111111111111.png#10x20");
            }
        }

        String rewritten = PostPackageRefs.rewrite(body, replacements);

        assertThat(rewritten)
                .isEqualTo(
                        "Before ![A](/media/11111111-1111-1111-1111-111111111111.png#10x20 \"T\") and [B](assets/b.png) after\n\n"
                                + ":::figure{src=\"/media/11111111-1111-1111-1111-111111111111.png#10x20\" alt=\"x\"}\n:::\n");
    }
}
