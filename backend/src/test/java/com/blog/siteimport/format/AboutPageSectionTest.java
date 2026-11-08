package com.blog.siteimport.format;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.sitecontent.schema.SiteContentKey;
import com.blog.siteimport.format.ParsedProfile.ParsedSection;
import java.util.EnumMap;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/** The About page section: a verbatim Markdown document, read up to the next level 1 heading outside a code fence. */
class AboutPageSectionTest {

    private static final String FRONT = """
            ---
            schema_version: 1
            content_type: site-profile
            locale: en
            ---

            """;

    private static final String BODY = """
            Opening paragraph.

            ## A heading

            :::callout{type="tip" title="Note"}
            Inside a block.
            :::

            ```bash
            # a comment line, not a heading
            echo done
            ```

            | Name | Value |
            |---|---|
            | a | b |

            - one
              - nested
            - two

            ### Deeper heading

            ---
            """.strip();

    private static ParsedProfile parse(String sections) {
        return ProfileMarkdownParser.parse(FRONT + sections);
    }

    private static Optional<ParsedSection> aboutPage(ParsedProfile parsed) {
        return parsed.sections().stream()
                .filter(s -> s.descriptor().id().equals("about-page"))
                .findFirst();
    }

    @Test
    void the_section_is_registered_for_the_about_key_right_after_about() {
        var ids = SectionRegistry.sections().stream().map(SectionDescriptor::id).toList();

        assertThat(ids.indexOf("about-page")).isEqualTo(ids.indexOf("about") + 1);
        SectionDescriptor descriptor = SectionRegistry.byHeading("about page").orElseThrow();
        assertThat(descriptor.key()).isEqualTo(SiteContentKey.ABOUT);
        assertThat(ProfileMarkdownParser.listName(descriptor.parts().getFirst()))
                .isEqualTo("body");
    }

    @Test
    void fences_blocks_tables_lists_and_deeper_headings_are_body_text() {
        ParsedProfile parsed = parse("# About page\n\n" + BODY + "\n");

        assertThat(parsed.problems()).isEmpty();
        ParsedSection section = aboutPage(parsed).orElseThrow();
        assertThat(section.patch().get("body").asString()).isEqualTo(BODY);
        assertThat(section.presentFields()).containsExactly("body");
        assertThat(section.lines().get("/body")).isEqualTo(9);
    }

    @Test
    void a_level_1_heading_outside_a_fence_ends_the_body_and_the_next_section_is_read() {
        ParsedProfile parsed = parse("""
                # About page

                Body text.

                # Site

                - name: Example Site
                """);

        assertThat(parsed.problems()).isEmpty();
        assertThat(aboutPage(parsed).orElseThrow().patch().get("body").asString())
                .isEqualTo("Body text.");
        assertThat(parsed.sections()).extracting(s -> s.descriptor().id()).containsExactly("about-page", "site");
    }

    @Test
    void a_hash_line_inside_a_tilde_fence_or_a_longer_fence_does_not_end_the_body() {
        ParsedProfile parsed = parse("""
                # About page

                ~~~
                # inside tilde
                ~~~

                ````markdown
                ```
                # inside four ticks
                ```
                ````

                After.
                """);

        assertThat(parsed.problems()).isEmpty();
        String body = aboutPage(parsed).orElseThrow().patch().get("body").asString();
        assertThat(body)
                .contains("# inside tilde")
                .contains("# inside four ticks")
                .endsWith("After.");
    }

    @Test
    void comment_blocks_outside_fences_are_skipped_and_inside_fences_are_kept() {
        ParsedProfile parsed = parse("""
                # About page

                <!--
                instructions for the author
                -->

                Visible.

                ```html
                <!-- kept -->
                ```
                """);

        assertThat(parsed.problems()).isEmpty();
        String body = aboutPage(parsed).orElseThrow().patch().get("body").asString();
        assertThat(body).doesNotContain("instructions").contains("Visible.").contains("<!-- kept -->");
    }

    @Test
    void blank_lines_inside_are_kept_and_the_ends_are_trimmed() {
        ParsedProfile parsed = parse("# About page\n\n\n\nA\n\n\nB\n\n\n");

        assertThat(aboutPage(parsed).orElseThrow().patch().get("body").asString())
                .isEqualTo("A\n\n\nB");
    }

    @Test
    void a_section_without_text_writes_nothing() {
        ParsedProfile parsed = parse("""
                # About page

                <!-- only a comment -->

                # Site

                - name: Example Site
                """);

        assertThat(parsed.problems()).isEmpty();
        ParsedSection section = aboutPage(parsed).orElseThrow();
        assertThat(section.patch().isEmpty()).isTrue();
        assertThat(section.presentFields()).isEmpty();
    }

    @Test
    void a_body_over_the_limit_is_a_problem_that_names_the_limit_and_not_the_text() {
        String secret = "confidential-sentence ";
        String text = secret.repeat(1000);
        ParsedProfile parsed = parse("# About page\n\n" + text + "\n");

        assertThat(parsed.problems()).hasSize(1);
        ParsedProfile.Problem problem = parsed.problems().getFirst();
        assertThat(problem.sectionId()).isEqualTo("about-page");
        assertThat(problem.field()).isEqualTo("body");
        assertThat(problem.message()).contains("20000").doesNotContain("confidential");
        assertThat(aboutPage(parsed).orElseThrow().patch().isEmpty()).isTrue();
    }

    @Test
    void a_body_of_exactly_the_limit_is_accepted() {
        ParsedProfile parsed = parse("# About page\n\n" + "a".repeat(20000) + "\n");

        assertThat(parsed.problems()).isEmpty();
        assertThat(aboutPage(parsed).orElseThrow().patch().get("body").asString())
                .hasSize(20000);
    }

    @Test
    void a_repeated_section_is_the_repeated_section_problem() {
        ParsedProfile parsed = parse("""
                # About page

                First.

                # About page

                Second.
                """);

        assertThat(parsed.problems()).hasSize(1);
        assertThat(parsed.problems().getFirst().sectionId()).isEqualTo("about-page");
        assertThat(parsed.problems().getFirst().message()).contains("appears twice");
    }

    @Test
    void the_rules_for_other_sections_do_not_change() {
        ParsedProfile parsed = parse("""
                # Site

                ```
                - name: Example Site
                """);

        assertThat(parsed.problems())
                .extracting(ParsedProfile.Problem::message)
                .contains("code fences are not supported");
    }

    @Test
    void export_then_import_gives_the_same_body_and_about_content() {
        ObjectNode about = (ObjectNode) ProfileRoundTrip.packagedDefaults("en").get(SiteContentKey.ABOUT);
        about = about.deepCopy();
        about.put("body", BODY);
        Map<SiteContentKey, JsonNode> payloads = new EnumMap<>(SiteContentKey.class);
        payloads.put(SiteContentKey.ABOUT, ProfileRoundTrip.normalized(SiteContentKey.ABOUT, about));

        String plain = ProfileMarkdownWriter.write("en", payloads, false);
        String annotated = ProfileMarkdownWriter.write("en", payloads, true);

        for (String file : new String[] {plain, annotated}) {
            Map<SiteContentKey, JsonNode> back = ProfileRoundTrip.importFile(file);
            assertThat(back.get(SiteContentKey.ABOUT)).isEqualTo(payloads.get(SiteContentKey.ABOUT));
        }
        assertThat(plain).contains("# About page\n\n" + BODY + "\n");
    }

    @Test
    void an_about_without_a_body_exports_no_about_page_section_but_the_template_has_one() {
        Map<SiteContentKey, JsonNode> payloads = ProfileRoundTrip.packagedDefaults("en");

        assertThat(ProfileMarkdownWriter.write("en", payloads, false)).doesNotContain("# About page");
        String template = new TemplateGenerator().template("en");
        assertThat(template).contains("# About page").contains(":::callout{");
        ParsedProfile parsed = ProfileMarkdownParser.parse(template);
        assertThat(parsed.problems()).isEmpty();
        assertThat(aboutPage(parsed).orElseThrow().patch().get("body").asString())
                .doesNotContain("<!--")
                .contains("## ");
    }

    @Test
    void the_generated_reference_lists_the_section() {
        String reference = FormatReference.markdown();

        assertThat(reference).contains("### About page").contains("| `body` | optional | Markdown document");
    }
}
