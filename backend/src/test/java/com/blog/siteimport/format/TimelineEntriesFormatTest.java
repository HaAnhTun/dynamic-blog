package com.blog.siteimport.format;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.tuple;

import com.blog.sitecontent.schema.SiteContentKey;
import com.blog.siteimport.format.ParsedProfile.ParsedSection;
import com.blog.siteimport.format.ParsedProfile.Problem;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The timeline entries of the profile file: one {@code ## Title {kind=...}} group per entry with {@code - name: value} lines
 * (a repeatable highlight line, a technologies line with pipe-separated items), the older five-column {@code ## Entries}
 * rows that still import unchanged, and the export that writes the groups and reads back as it was.
 */
class TimelineEntriesFormatTest {

    private static final String FRONT = "---\nschema_version: 1\ncontent_type: site-profile\nlocale: en\n---\n\n";
    private static final String LOGO = "/media/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.png";

    private static final String FULL_ENTRY = """
            # Timeline
            - experience_summary: Years of work.

            ## Platform Engineer {kind=experience}
            - org: Example Corp
            - url: https://example.com/team
            - logo: assets/example.png
            - location: Example City
            - department: Platform
            - period: 09/2023 - Present
            - summary: Builds and runs services.
            - tech: Java | Spring Boot | C\\|C
            - highlight: Cut the build time: from ten minutes to two.
            - highlight: Wrote the onboarding guide.

            ## BSc Software {kind=education}
            - org: Example College
            - period: 2019 - 2023
            """;

    private static ParsedProfile parse(String body) {
        return ProfileMarkdownParser.parse(FRONT + body);
    }

    private static ParsedSection timeline(ParsedProfile parsed) {
        return parsed.sections().stream()
                .filter(s -> s.descriptor().id().equals("timeline"))
                .findFirst()
                .orElseThrow();
    }

    private static JsonNode json(String text) {
        return ProfileRoundTrip.MAPPER.readTree(text);
    }

    @Test
    void entry_groups_carry_every_detail() {
        ParsedProfile parsed = parse(FULL_ENTRY);

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored()).isEmpty();
        assertThat(timeline(parsed).patch()).isEqualTo(json("""
            {"experienceSummary": "Years of work.",
             "entries": [
               {"title": "Platform Engineer", "kind": "experience", "org": "Example Corp",
                "url": "https://example.com/team", "logo": "assets/example.png", "location": "Example City",
                "department": "Platform", "period": "09/2023 - Present", "summary": "Builds and runs services.",
                "tech": ["Java", "Spring Boot", "C|C"],
                "highlights": ["Cut the build time: from ten minutes to two.", "Wrote the onboarding guide."]},
               {"title": "BSc Software", "kind": "education", "org": "Example College",
                "period": "2019 - 2023", "summary": ""}]}\
            """));
        assertThat(timeline(parsed).presentFields()).contains("experience_summary", "entries");
    }

    @Test
    void an_entry_with_nothing_but_its_title_and_kind_is_filled_like_a_row() {
        ParsedProfile parsed = parse("# Timeline\n\n## Course {kind=education}\n");

        assertThat(parsed.problems()).isEmpty();
        assertThat(timeline(parsed).patch()).isEqualTo(json("""
            {"entries": [{"title": "Course", "kind": "education", "org": null, "period": null, "summary": ""}]}\
            """));
    }

    @Test
    void a_missing_kind_is_the_empty_value_for_the_validator_to_refuse() {
        ParsedProfile parsed = parse("# Timeline\n\n## Course\n- org: Example College\n");

        assertThat(parsed.problems()).isEmpty();
        assertThat(timeline(parsed).patch().at("/entries/0/kind").asString("missing"))
                .isEmpty();
    }

    @Test
    void the_older_five_column_rows_still_import_unchanged() {
        ParsedProfile parsed = parse("""
                # Timeline
                ## Entries
                - experience | Engineer | Example Org | 2020 - 2024 | Built things.
                - education | Degree
                """);

        assertThat(parsed.problems()).isEmpty();
        assertThat(timeline(parsed).patch()).isEqualTo(json("""
            {"entries": [
              {"kind": "experience", "title": "Engineer", "org": "Example Org", "period": "2020 - 2024",
               "summary": "Built things."},
              {"kind": "education", "title": "Degree", "org": null, "period": null, "summary": ""}]}\
            """));
        assertThat(timeline(parsed).presentFields()).containsExactly("Entries");
    }

    @Test
    void rows_and_groups_together_are_a_problem() {
        ParsedProfile parsed = parse("""
                # Timeline
                ## Entries
                - experience | Engineer

                ## Course {kind=education}
                """);

        assertThat(parsed.problems())
                .extracting(Problem::sectionId, Problem::field)
                .containsExactly(tuple("timeline", "entries"));
        assertThat(parsed.problems().get(0).message()).doesNotContain("Engineer");
    }

    @Test
    void a_field_given_twice_in_one_entry_is_a_problem_but_the_same_field_in_two_entries_is_not() {
        ParsedProfile parsed = parse("""
                # Timeline

                ## One {kind=experience}
                - org: First
                - org: Second

                ## Two {kind=experience}
                - org: Third
                """);

        assertThat(parsed.problems()).hasSize(1);
        assertThat(parsed.problems().get(0).field()).isEqualTo("org");
        assertThat(parsed.problems().get(0).line()).isEqualTo(11);
        assertThat(parsed.problems().get(0).message()).contains("given twice").contains("line 10");
    }

    @Test
    void an_unknown_field_is_ignored_and_listed_and_other_lines_are_problems() {
        ParsedProfile parsed = parse("""
                # Timeline

                ## One {kind=experience}
                - website: https://example.com/
                Loose text.
                - no colon here
                """);

        assertThat(parsed.ignored()).extracting(ParsedProfile.Ignored::name).containsExactly("website");
        assertThat(parsed.problems()).extracting(Problem::line).containsExactly(11, 12);
    }

    @Test
    void an_entry_has_no_id_and_an_unknown_attribute_is_a_problem() {
        ParsedProfile withId = parse("# Timeline\n\n## One {#one kind=experience}\n");
        ParsedProfile unknown = parse("# Timeline\n\n## One {kind=experience level=learning}\n");

        assertThat(withId.problems()).hasSize(1);
        assertThat(unknown.problems()).hasSize(1);
    }

    @Test
    void empty_values_count_as_absent_and_empty_cells_of_the_technologies_are_dropped() {
        ParsedProfile parsed = parse("""
                # Timeline

                ## One {kind=experience}
                - url:
                - tech: Java | | Go |
                - highlight:
                """);

        assertThat(parsed.problems()).isEmpty();
        assertThat(timeline(parsed).patch().at("/entries/0")).isEqualTo(json("""
                    {"title": "One", "kind": "experience", "org": null, "period": null, "summary": "",
                     "tech": ["Java", "Go"]}\
                    """));
    }

    @Test
    void the_lines_of_a_problem_point_at_the_entry_and_its_values() {
        ParsedSection section = timeline(parse(FULL_ENTRY));

        assertThat(section.lines())
                .containsEntry("/entries/0", 10)
                .containsEntry("/entries/0/url", 12)
                .containsEntry("/entries/0/highlights/1", 20)
                .containsEntry("/entries/0/tech/2", 18)
                .containsEntry("/entries/1/org", 23);
    }

    @Test
    void every_value_of_the_patch_has_a_field_name_and_a_line() {
        ParsedSection section = timeline(parse(FULL_ENTRY));
        List<String> leaves = new ArrayList<>();
        collectLeaves(section.patch(), "", leaves);

        assertThat(leaves).hasSizeGreaterThan(15);
        for (String leaf : leaves) {
            assertThat(SectionRegistry.fieldNameFor(section.descriptor(), leaf))
                    .as(leaf)
                    .isNotNull();
            assertThat(section.lines()).as(leaf).containsKey(leaf);
        }
    }

    private static void collectLeaves(JsonNode node, String pointer, List<String> leaves) {
        if (node.isObject()) {
            node.properties().forEach(e -> collectLeaves(e.getValue(), pointer + "/" + e.getKey(), leaves));
        } else if (node.isArray()) {
            for (int i = 0; i < node.size(); i++) {
                collectLeaves(node.get(i), pointer + "/" + i, leaves);
            }
        } else {
            leaves.add(pointer);
        }
    }

    @Test
    void a_problem_never_repeats_a_value_of_the_file() {
        String mark = "ZZSECRETZZ";
        ParsedProfile parsed = parse("# Timeline\n## Entries\n- experience | " + mark + "\n\n## " + mark + " {#" + mark
                + " kind=" + mark + " " + mark + "=y}\n- org: " + mark + "\n- org: " + mark + "\n- tech: " + mark
                + "\n- tech: " + mark + "\n" + mark + "\n- " + mark + "\n- " + mark + ": " + mark + "\n");

        assertThat(parsed.problems()).isNotEmpty();
        for (Problem problem : parsed.problems()) {
            assertThat(String.valueOf(problem.message())).doesNotContain(mark);
            assertThat(String.valueOf(problem.field())).doesNotContain(mark);
        }
    }

    @Test
    void a_list_line_past_the_item_limit_is_one_problem_and_the_rest_is_not_read() {
        StringBuilder file = new StringBuilder("# Timeline\n\n## One {kind=experience}\n");
        for (int i = 0; i < ProfileMarkdownParser.MAX_LIST_ITEMS + 5; i++) {
            file.append("- highlight: line ").append(i).append('\n');
        }

        ParsedProfile parsed = parse(file.toString());

        assertThat(parsed.problems()).hasSize(1);
        assertThat(parsed.problems().get(0).field()).isEqualTo("highlight");
        assertThat(timeline(parsed).patch().at("/entries/0/highlights").size())
                .isEqualTo(ProfileMarkdownParser.MAX_LIST_ITEMS);
    }

    @Test
    void the_field_names_of_the_new_values_are_known_to_the_reports() {
        SectionDescriptor descriptor = SectionRegistry.byId("timeline").orElseThrow();

        assertThat(SectionRegistry.fieldNameFor(descriptor, "/entries/3/highlights/2"))
                .isEqualTo("highlight");
        assertThat(SectionRegistry.fieldNameFor(descriptor, "/entries/3/tech/0"))
                .isEqualTo("tech");
        assertThat(SectionRegistry.fieldNameFor(descriptor, "/entries/3/logo")).isEqualTo("logo");
        assertThat(SectionRegistry.fieldNameFor(descriptor, "/entries/3/kind")).isEqualTo("kind");
        assertThat(SectionRegistry.fieldNameFor(descriptor, "/entries/3/title")).isEqualTo("title");
    }

    // ---- export ---------------------------------------------------------------------------------------------------

    private static Map<SiteContentKey, JsonNode> payloadsWithDetails() {
        Map<SiteContentKey, JsonNode> payloads = ProfileRoundTrip.packagedDefaults("en");
        ObjectNode timeline = ProfileRoundTrip.copy(payloads.get(SiteContentKey.TIMELINE));
        ArrayNode entries = timeline.putArray("entries");
        ObjectNode job = entries.addObject();
        job.put("kind", "experience")
                .put("title", "Platform Engineer")
                .put("org", "Example Corp")
                .put("period", "09/2023 - Present")
                .put("summary", "Builds and runs services.")
                .put("url", "https://example.com/team")
                .put("location", "Example City")
                .put("department", "Platform")
                .put("logo", LOGO);
        job.putArray("highlights")
                .add("Cut the build time: from ten minutes to two.")
                .add("Wrote | and \\ in a note.");
        job.putArray("tech").add("Java").add("C|C").add("Back\\slash").add("Spring Boot");
        entries.addObject()
                .putNull("org")
                .putNull("period")
                .put("kind", "education")
                .put("title", "BSc Software")
                .put("summary", "");
        payloads.put(SiteContentKey.TIMELINE, ProfileRoundTrip.normalized(SiteContentKey.TIMELINE, timeline));
        return payloads;
    }

    @Test
    void the_export_writes_entry_groups_with_every_detail_and_reads_back_as_it_was() {
        Map<SiteContentKey, JsonNode> payloads = payloadsWithDetails();

        String file = ProfileMarkdownWriter.write("en", payloads, false);

        assertThat(file)
                .contains("\n## Platform Engineer {kind=experience}\n\n- org: Example Corp\n")
                .contains("\n- logo: " + LOGO + "\n")
                .contains("\n- tech: Java | C\\|C | Back\\slash | Spring Boot\n")
                .contains("\n- highlight: Cut the build time: from ten minutes to two.\n")
                .contains("\n## BSc Software {kind=education}\n")
                .doesNotContain("## Entries");
        assertThat(ProfileRoundTrip.importFile(file)).isEqualTo(payloads);
    }

    @Test
    void an_entry_without_details_writes_an_empty_line_for_each_so_the_fields_can_be_found() {
        String file = ProfileMarkdownWriter.write("en", ProfileRoundTrip.packagedDefaults("en"), false);

        assertThat(file)
                .contains("\n## Your degree or course {kind=education}\n\n- org:\n- url:\n- logo:\n- location:\n")
                .contains("\n- tech:\n- highlight:\n");
        assertThat(ProfileRoundTrip.importFile(file)).isEqualTo(ProfileRoundTrip.packagedDefaults("en"));
    }

    @Test
    void the_annotated_output_describes_the_new_fields_and_the_older_rows() {
        String annotated = ProfileMarkdownWriter.write("en", payloadsWithDetails(), true);

        assertThat(annotated)
                .contains("- logo (optional): ")
                .contains("- highlight (optional): ")
                .contains("- tech (optional): ")
                .contains("attribute kind (required): ");
        assertThat(ProfileRoundTrip.importFile(annotated)).isEqualTo(payloadsWithDetails());
    }

    @Test
    void the_template_shows_every_entry_field_and_tells_an_assistant_how_to_write_an_entry_and_a_logo() {
        String template = new TemplateGenerator().template("en");

        assertThat(template)
                .contains("## Your degree or course {kind=education}")
                .contains("\n- logo:\n", "\n- tech:\n", "\n- highlight:\n", "\n- department:\n")
                .contains("## Title {kind=experience}")
                .contains("- tech: Java | Spring Boot")
                .contains("once per achievement")
                .contains("the logo of a Timeline entry")
                .contains("- highlight (optional): ");
        assertThat(template.lines())
                .as("the template writes groups, not the older rows")
                .doesNotContain("## Entries");
        assertThat(ProfileMarkdownParser.parse(template).problems()).isEmpty();
    }

    @Test
    void the_reference_lists_every_entry_field_with_its_kind_of_line() {
        String reference = FormatReference.markdown();

        assertThat(reference)
                .contains(
                        "| `highlight` | optional | entry field, a `- name: value` line that may repeat, one item each |")
                .contains("| `tech` | optional | entry field, one `- name: value` line with items separated by pipes |")
                .contains("| `logo` | optional | entry field, a `- name: value` line |")
                .contains("| `kind` | required | group attribute in the braces |");
    }
}
