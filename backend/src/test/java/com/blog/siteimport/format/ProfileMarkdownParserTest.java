package com.blog.siteimport.format;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.siteimport.format.ParsedProfile.Ignored;
import com.blog.siteimport.format.ParsedProfile.ParsedSection;
import com.blog.siteimport.format.ParsedProfile.Problem;
import java.text.Normalizer;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/** What the parser makes of a profile file: front matter, sections, parts, fills, line numbers and problems. */
class ProfileMarkdownParserTest {

    static final JsonMapper MAPPER = JsonMapper.builder().build();

    /** Five lines: the body of {@link #file} starts on line 6. */
    static final String FRONT = """
        ---
        schema_version: 1
        content_type: site-profile
        locale: en
        ---
        """;

    static final String FULL = """
        <!-- Instructions for the assistant.
        # Site
        - name: never read
        -->

        # Site
        - name: Example Site
        - tagline: Notes on building software
        - positioning: A personal site with articles.

        # Identity
        - name: Alex Example
        - role: Software engineer
        - location: Example City
        - greeting: Hello, I am Alex.
        - headline: I build web applications.
        - subline: Articles about the backend and the frontend.
        - gallery_lead: A few photos.

        # Career goals
        Looking for a team that
        values testing.

        # About
        An introduction paragraph.

        ## Who I am {#who}
        First paragraph
          continues here.

        Second paragraph.

        ## What I am learning
        Only paragraph.

        # Skills
        ## Backend {#backend level=used-in-project}
        - Java
        - Docker | worked-with
        - Kubernetes | learning | Reading the docs

        ## K{1EF9} n{0103}ng {0110}{1EB7}c bi{1EC7}t {level=learning}
        - Rust

        # Now
        - last_updated: 2026-10-11
        - intro: What I do now.

        ## Items
        - Writing a post.
        - Reading | All posts | /writing

        # Timeline
        - experience_summary: Some years of work.

        ## Entries
        - experience | Engineer | Example Org | 2020 - 2024 | Built things.
        - education | Degree

        # Contact
        - email: someone@example.com
        - github: https://github.com/example
        - blurb: Write to me.

        ## Social links
        - Mastodon | https://example.social/@someone

        # Blogroll
        - Example Blog | https://blog.example.com | Good \\| sharp notes
        - Other | https://other.example.com
        """;

    static String file(String body) {
        return FRONT + body;
    }

    /** Test text with non-ASCII letters written as {XXXX} code points, so the sources stay ASCII. */
    static String u(String text) {
        StringBuilder out = new StringBuilder();
        int i = 0;
        while (i < text.length()) {
            int close = text.indexOf('}', i);
            if (text.charAt(i) == '{'
                    && close == i + 5
                    && text.substring(i + 1, close).matches("[0-9A-F]{4}")) {
                out.appendCodePoint(Integer.parseInt(text.substring(i + 1, close), 16));
                i = close + 1;
            } else {
                out.append(text.charAt(i++));
            }
        }
        return out.toString();
    }

    static ObjectNode json(String text) {
        return (ObjectNode) MAPPER.readTree(text);
    }

    static ParsedProfile parse(String text) {
        return ProfileMarkdownParser.parse(text);
    }

    static ParsedSection section(ParsedProfile parsed, String id) {
        return parsed.sections().stream()
                .filter(s -> s.descriptor().id().equals(id))
                .findFirst()
                .orElseThrow(() -> new AssertionError("no section " + id));
    }

    @Test
    void a_complete_file_gives_every_section_without_problems() {
        ParsedProfile parsed = parse(u(file(FULL)));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored()).isEmpty();
        assertThat(parsed.ignoredTotal()).isZero();
        assertThat(parsed.schemaVersion()).isEqualTo("1");
        assertThat(parsed.contentType()).isEqualTo("site-profile");
        assertThat(parsed.locale()).isEqualTo("en");
        assertThat(parsed.sections())
                .extracting(s -> s.descriptor().id())
                .containsExactly(
                        "site",
                        "identity",
                        "career-goals",
                        "about",
                        "skills",
                        "now",
                        "timeline",
                        "contact",
                        "blogroll");

        assertThat(section(parsed, "site").patch()).isEqualTo(json("""
            {"name": "Example Site", "tagline": "Notes on building software",
             "positioning": "A personal site with articles."}\
            """));
        assertThat(section(parsed, "identity").patch()).isEqualTo(json("""
            {"name": "Alex Example", "role": "Software engineer", "location": "Example City",
             "hero": {"greeting": "Hello, I am Alex.", "headline": "I build web applications.",
                      "subline": "Articles about the backend and the frontend."},
             "galleryLead": "A few photos."}\
            """));
        assertThat(section(parsed, "career-goals").patch())
                .isEqualTo(json("{\"seeking\": \"Looking for a team that values testing.\"}"));
        assertThat(section(parsed, "about").patch()).isEqualTo(json("""
            {"intro": "An introduction paragraph.",
             "sections": [
               {"title": "Who I am", "id": "who", "body": ["First paragraph continues here.", "Second paragraph."]},
               {"title": "What I am learning", "id": "what-i-am-learning", "body": ["Only paragraph."]}]}\
            """));
        assertThat(section(parsed, "skills").patch()).isEqualTo(json(u("""
            {"groups": [
              {"title": "Backend", "id": "backend", "defaultLevel": "used-in-project",
               "items": [{"name": "Java"}, {"name": "Docker", "level": "worked-with"},
                         {"name": "Kubernetes", "level": "learning", "note": "Reading the docs"}]},
              {"title": "K{1EF9} n{0103}ng {0110}{1EB7}c bi{1EC7}t", "id": "ky-nang-dac-biet",
               "defaultLevel": "learning", "items": [{"name": "Rust"}]}]}\
            """)));
        assertThat(section(parsed, "now").patch()).isEqualTo(json("""
            {"lastUpdated": "2026-10-11", "intro": "What I do now.",
             "items": [{"text": "Writing a post."},
                       {"text": "Reading", "evidence": {"label": "All posts", "href": "/writing"}}]}\
            """));
        assertThat(section(parsed, "timeline").patch()).isEqualTo(json("""
            {"experienceSummary": "Some years of work.",
             "entries": [
               {"kind": "experience", "title": "Engineer", "org": "Example Org", "period": "2020 - 2024",
                "summary": "Built things."},
               {"kind": "education", "title": "Degree", "org": null, "period": null, "summary": ""}]}\
            """));
        assertThat(section(parsed, "contact").patch()).isEqualTo(json("""
            {"email": "someone@example.com", "github": "https://github.com/example", "blurb": "Write to me.",
             "social": [{"label": "Mastodon", "url": "https://example.social/@someone"}]}\
            """));
        assertThat(section(parsed, "blogroll").patch()).isEqualTo(json("""
            {"entries": [
              {"name": "Example Blog", "url": "https://blog.example.com", "note": "Good | sharp notes"},
              {"name": "Other", "url": "https://other.example.com"}]}\
            """));
    }

    @Test
    void lines_map_every_pointer_to_its_file_line() {
        ParsedProfile parsed = parse(u(file(FULL)));
        // FRONT is 5 lines, the comment block 4 more, then a blank line: "# Site" is line 11.
        ParsedSection site = section(parsed, "site");
        assertThat(site.line()).isEqualTo(11);
        assertThat(site.lines())
                .containsEntry("", 11)
                .containsEntry("/name", 12)
                .containsEntry("/positioning", 14);

        ParsedSection identity = section(parsed, "identity");
        assertThat(identity.lines()).containsEntry("/hero/headline", 21);

        ParsedSection goals = section(parsed, "career-goals");
        assertThat(goals.lines()).containsEntry("/seeking", 26);

        ParsedSection about = section(parsed, "about");
        assertThat(about.lines())
                .containsEntry("/intro", 30)
                .containsEntry("/sections", 32)
                .containsEntry("/sections/0", 32)
                .containsEntry("/sections/0/title", 32)
                .containsEntry("/sections/0/id", 32)
                .containsEntry("/sections/0/body/0", 33)
                .containsEntry("/sections/0/body/1", 36)
                .containsEntry("/sections/1/body/0", 39);

        ParsedSection skills = section(parsed, "skills");
        assertThat(skills.lines())
                .containsEntry("/groups", 42)
                .containsEntry("/groups/0/defaultLevel", 42)
                .containsEntry("/groups/0/items/1", 44)
                .containsEntry("/groups/0/items/1/level", 44)
                .containsEntry("/groups/1", 47)
                .containsEntry("/groups/1/items/0/name", 48);

        ParsedSection now = section(parsed, "now");
        assertThat(now.lines())
                .containsEntry("/lastUpdated", 51)
                .containsEntry("/items", 54)
                .containsEntry("/items/1", 56)
                .containsEntry("/items/1/evidence/href", 56);

        ParsedSection blogroll = section(parsed, "blogroll");
        assertThat(blogroll.lines()).containsEntry("/entries", 74).containsEntry("/entries/1/url", 75);
    }

    @Test
    void present_fields_name_the_values_and_lists_the_file_gave() {
        ParsedProfile parsed = parse(u(file(FULL)));
        assertThat(section(parsed, "about").presentFields()).containsExactly("intro", "sections");
        assertThat(section(parsed, "skills").presentFields()).containsExactly("groups");
        assertThat(section(parsed, "now").presentFields()).containsExactly("last_updated", "intro", "Items");
        assertThat(section(parsed, "contact").presentFields())
                .containsExactly("email", "github", "blurb", "Social links");
        assertThat(section(parsed, "blogroll").presentFields()).containsExactly("entries");

        ParsedProfile partial = parse(file("# Identity\n- name: A\n- role:\n"));
        assertThat(section(partial, "identity").presentFields()).containsExactly("name");
    }

    // ---- front matter ------------------------------------------------------------------------------------------

    @Test
    void front_matter_values_may_be_quoted() {
        ParsedProfile parsed = parse("---\nschema_version: \"1\"\ncontent_type: 'site-profile'\nlocale: \"vi'\n---\n");
        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.schemaVersion()).isEqualTo("1");
        assertThat(parsed.contentType()).isEqualTo("site-profile");
        assertThat(parsed.locale()).isEqualTo("\"vi'");
    }

    @Test
    void front_matter_values_are_returned_raw_for_the_service_to_check() {
        ParsedProfile parsed = parse("---\nschema_version: 2\ncontent_type: other\nlocale:\n---\n");
        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.schemaVersion()).isEqualTo("2");
        assertThat(parsed.contentType()).isEqualTo("other");
        assertThat(parsed.locale()).isEmpty();
    }

    @Test
    void blank_lines_before_and_inside_the_front_matter_are_allowed() {
        ParsedProfile parsed = parse("\n\n---\nschema_version: 1\n\ncontent_type: site-profile\nlocale: vi\n---\n");
        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.locale()).isEqualTo("vi");
    }

    @Test
    void a_missing_front_matter_key_is_a_problem() {
        ParsedProfile parsed = parse("---\nschema_version: 1\ncontent_type: site-profile\n---\n");
        assertThat(parsed.locale()).isNull();
        assertThat(parsed.problems())
                .containsExactly(new Problem(null, "locale", 1, "the front matter key locale is missing"));
    }

    @Test
    void an_unknown_front_matter_key_is_a_problem_that_does_not_echo_it() {
        ParsedProfile parsed = parse(file("").replace("locale: en\n", "locale: en\nqqsecretqq: x\n"));
        assertThat(parsed.problems()).containsExactly(new Problem(null, null, 5, "unknown front matter key"));
    }

    @Test
    void a_repeated_front_matter_key_is_a_problem_and_the_first_value_wins() {
        ParsedProfile parsed = parse(file("").replace("locale: en\n", "locale: en\nlocale: vi\n"));
        assertThat(parsed.locale()).isEqualTo("en");
        assertThat(parsed.problems())
                .containsExactly(
                        new Problem(null, "locale", 5, "the front matter key locale is given twice; first at line 4"));
    }

    @Test
    void a_file_without_front_matter_is_a_problem() {
        ParsedProfile parsed = parse("# Site\n- name: A\n");
        assertThat(parsed.schemaVersion()).isNull();
        assertThat(parsed.contentType()).isNull();
        assertThat(parsed.locale()).isNull();
        assertThat(parsed.problems())
                .containsExactly(
                        new Problem(null, null, 1, "the file must start with front matter between two --- lines"));
        assertThat(section(parsed, "site").patch()).isEqualTo(json("{\"name\": \"A\"}"));
    }

    @Test
    void an_unclosed_front_matter_is_a_problem_and_ends_at_the_first_heading() {
        ParsedProfile parsed =
                parse("---\nschema_version: 1\ncontent_type: site-profile\nlocale: en\n# Site\n- name: A\n");
        assertThat(parsed.locale()).isEqualTo("en");
        assertThat(parsed.problems())
                .containsExactly(new Problem(null, null, 1, "the front matter is not closed with ---"));
        assertThat(section(parsed, "site").patch()).isEqualTo(json("{\"name\": \"A\"}"));
    }

    @Test
    void a_front_matter_line_that_is_not_key_value_is_a_problem() {
        ParsedProfile parsed = parse(file("").replace("locale: en\n", "locale: en\njust text\n"));
        assertThat(parsed.problems())
                .containsExactly(new Problem(null, null, 5, "front matter lines must be key: value"));
    }

    // ---- structure problems ------------------------------------------------------------------------------------

    static Stream<Arguments> structureProblems() {
        return Stream.of(
                Arguments.of("Hello\n# Site\n", null, 6, "text before the first section heading is not allowed"),
                Arguments.of("## Items\n# Site\n", null, 6, "text before the first section heading is not allowed"),
                Arguments.of("# Site\n### Deep\n", "site", 7, "### and deeper headings are not supported"),
                Arguments.of("# Site\n  # Identity\n", "site", 7, "a heading must start at the beginning of the line"),
                Arguments.of("# Site\n```\n", "site", 7, "code fences are not supported"),
                Arguments.of("# Site\n~~~ text\n", "site", 7, "code fences are not supported"),
                Arguments.of("# Site\n---\n", "site", 7, "a line of only ---, *** or ___ is not allowed"),
                Arguments.of("# Site\n***\n", "site", 7, "a line of only ---, *** or ___ is not allowed"),
                Arguments.of("# Site\n___\n", "site", 7, "a line of only ---, *** or ___ is not allowed"),
                Arguments.of("# Site\n- - -\n", "site", 7, "a line of only ---, *** or ___ is not allowed"),
                Arguments.of(
                        "# Site\n- name: A\n  - nested\n", "site", 8, "nested (indented) list items are not supported"),
                Arguments.of(
                        "# Now\n## Items\n- a\n\t* b\n", "now", 9, "nested (indented) list items are not supported"),
                Arguments.of(
                        "# About\nText\n  1. item\n", "about", 8, "nested (indented) list items are not supported"),
                Arguments.of("# Site\nplain text\n", "site", 7, "only - bullet lines are allowed here"),
                Arguments.of("# Site\n- name: A\n  continued\n", "site", 8, "only - bullet lines are allowed here"),
                Arguments.of("# Now\n## Items\nplain\n", "now", 8, "only - bullet lines are allowed here"),
                Arguments.of(
                        "# Skills\n## A {#a level=learning}\ntext\n",
                        "skills",
                        8,
                        "only - bullet lines are allowed here"),
                Arguments.of("# Skills\n- Java\n", "skills", 7, "start a ## group before this line"),
                Arguments.of("# Skills\nJava\n", "skills", 7, "start a ## group before this line"),
                Arguments.of(
                        "# Career goals\n- seeking: x\n",
                        "career-goals",
                        7,
                        "list items are not allowed here; write a paragraph"),
                Arguments.of(
                        "# About\n## Who\n- item\n", "about", 8, "list items are not allowed here; write paragraphs"),
                Arguments.of("# Career goals\nOne.\n\nTwo.\n", "career-goals", 9, "only one paragraph is allowed here"),
                Arguments.of("# About\nOne.\n<!-- c -->\nTwo.\n", "about", 9, "only one paragraph is allowed here"),
                Arguments.of(
                        "# Site\n- name: A\n- Name: B\n", "site", 8, "the field name is given twice; first at line 7"),
                Arguments.of(
                        "# Site\n- name: A\n- name:\n", "site", 8, "the field name is given twice; first at line 7"),
                Arguments.of("# Site\n- name\n", "site", 7, "a field must be written - name: value"),
                Arguments.of("# Site\n- name: A\n# site\n", "site", 8, "the section appears twice; first at line 6"),
                Arguments.of(
                        "# Now\n## Items\n- a\n## items\n- b\n",
                        "now",
                        9,
                        "the list Items appears twice; first at line 7"),
                Arguments.of(
                        "# Blogroll\n- a | b | c | d\n",
                        "blogroll",
                        7,
                        "this row has 4 cells but the list has only 3 columns"),
                Arguments.of(
                        "# Skills\n## A {#Back_End level=learning}\n",
                        "skills",
                        7,
                        "the group id must be 1 to 40 lowercase letters, digits or hyphens"),
                Arguments.of(
                        "# Skills\n## A {#}\n",
                        "skills",
                        7,
                        "the group id must be 1 to 40 lowercase letters, digits or hyphens"),
                Arguments.of(
                        "# Skills\n## A {#" + "a".repeat(41) + "}\n",
                        "skills",
                        7,
                        "the group id must be 1 to 40 lowercase letters, digits or hyphens"),
                Arguments.of("# Skills\n## A {#a #b level=learning}\n", "skills", 7, "the group id is given twice"),
                Arguments.of("# Skills\n## A {#a color=red}\n", "skills", 7, "unknown group attribute"),
                Arguments.of(
                        "# Skills\n## A {#a learning}\n", "skills", 7, "group attributes must be written key=value"),
                Arguments.of(
                        "# Skills\n## A {#a level=learning level=worked-with}\n",
                        "skills",
                        7,
                        "the attribute level is given twice"),
                Arguments.of(
                        "# Skills\n## Back end\n## Back-End!\n",
                        "skills",
                        8,
                        "two groups have the same id; first at line 7"),
                Arguments.of(
                        "# About\n## One {#same}\n## Two {#same}\n",
                        "about",
                        8,
                        "two groups have the same id; first at line 7"),
                Arguments.of(
                        "# Skills\n## !!! {level=learning}\n",
                        "skills",
                        7,
                        "add {#id}: no id can be derived from this title"),
                Arguments.of("# About\n## Background {#background\n", "about", 7, "the {...} block is not closed"),
                Arguments.of("# Skills\n## Backend {level=learning\n", "skills", 7, "the {...} block is not closed"),
                Arguments.of("# Site\n<!-- open\n- name: A\n", "site", 7, "the comment is not closed with -->"),
                Arguments.of(
                        "# Site\n<!-- x --> - name: A\n", "site", 7, "text after --> on the same line is not read"),
                Arguments.of("# Site\n<!-- x\ny --> z\n", "site", 8, "text after --> on the same line is not read"));
    }

    @ParameterizedTest
    @MethodSource("structureProblems")
    void structure_problems_name_the_section_and_the_line(String body, String sectionId, int line, String message) {
        ParsedProfile parsed = parse(file(body));
        assertThat(parsed.problems()).as(body).anySatisfy(p -> {
            assertThat(p.message()).isEqualTo(message);
            assertThat(p.sectionId()).isEqualTo(sectionId);
            assertThat(p.line()).isEqualTo(line);
        });
    }

    @Test
    void problems_carry_the_field_name_when_it_is_known() {
        ParsedProfile parsed = parse(file("# Site\n- name: A\n- name: B\n# Blogroll\n- a | b | c | d\n"));
        assertThat(parsed.problems()).extracting(Problem::field).containsExactly("name", "entries");
    }

    // ---- what is read and what is skipped ----------------------------------------------------------------------

    @Test
    void an_unknown_section_is_ignored_and_its_body_is_never_read() {
        ParsedProfile parsed =
                parse(file("# Projects\n```\n### x\n- name: Hidden\n---\n## Items\n# Site\n- name: B\n"));
        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored()).containsExactly(new Ignored("section", null, "Projects", 6));
        assertThat(parsed.ignoredTotal()).isEqualTo(1);
        assertThat(parsed.sections()).hasSize(1);
        assertThat(section(parsed, "site").patch()).isEqualTo(json("{\"name\": \"B\"}"));
    }

    @Test
    void the_body_of_a_duplicate_section_is_not_applied() {
        ParsedProfile parsed = parse(file("# Site\n- name: A\n# Site\n- tagline: B\n"));
        assertThat(parsed.sections()).hasSize(1);
        assertThat(section(parsed, "site").patch()).isEqualTo(json("{\"name\": \"A\"}"));
    }

    @Test
    void an_unknown_field_is_ignored_and_listed() {
        ParsedProfile parsed = parse(file("# Site\n- name: A\n- Favourite Colour: blue\n"));
        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored()).containsExactly(new Ignored("field", "site", "favourite_colour", 8));
        assertThat(section(parsed, "site").patch()).isEqualTo(json("{\"name\": \"A\"}"));
    }

    @Test
    void a_subsection_that_matches_no_part_is_ignored_with_its_body() {
        ParsedProfile parsed = parse(file("# Identity\n- name: A\n## Extra\n- role: B\nText\n### deep\n## Also\n"));
        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored())
                .containsExactly(
                        new Ignored("subsection", "identity", "Extra", 8),
                        new Ignored("subsection", "identity", "Also", 12));
        assertThat(section(parsed, "identity").patch()).isEqualTo(json("{\"name\": \"A\"}"));
    }

    @Test
    void ignored_entries_are_capped_but_counted() {
        StringBuilder body = new StringBuilder();
        for (int i = 0; i < 60; i++) {
            body.append("# Unknown ").append(i).append('\n');
        }
        ParsedProfile parsed = parse(file(body.toString()));
        assertThat(parsed.ignored()).hasSize(ProfileMarkdownParser.MAX_IGNORED);
        assertThat(parsed.ignoredTotal()).isEqualTo(60);
    }

    @Test
    void an_ignored_name_is_cut_to_80_characters() {
        ParsedProfile parsed = parse(file("# " + "x".repeat(200) + "\n"));
        assertThat(parsed.ignored().getFirst().name()).hasSize(80);
    }

    @Test
    void problems_are_capped_with_a_final_note() {
        ParsedProfile parsed = parse(file("# Site\n" + "### x\n".repeat(300)));
        assertThat(parsed.problems()).hasSize(ProfileMarkdownParser.MAX_PROBLEMS + 1);
        assertThat(parsed.problems().getLast().message()).startsWith("more problems were found");
    }

    @Test
    void comment_blocks_are_skipped_wherever_they_are() {
        ParsedProfile parsed =
                parse(file("<!--\n# Identity\n-->\n# Site\n<!-- note -->\n- name: A\n<!--\n- tagline: x\n-->\n"));
        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.sections()).hasSize(1);
        assertThat(section(parsed, "site").patch()).isEqualTo(json("{\"name\": \"A\"}"));
    }

    @Test
    void a_section_present_with_nothing_in_it_has_an_empty_patch() {
        ParsedProfile parsed = parse(file("# Site\n\n# Skills\n<!-- nothing -->\n"));
        assertThat(parsed.problems()).isEmpty();
        assertThat(section(parsed, "site").patch().isEmpty()).isTrue();
        assertThat(section(parsed, "site").lines()).containsExactly(Map.entry("", 6));
        assertThat(section(parsed, "skills").patch().isEmpty()).isTrue();
        assertThat(section(parsed, "skills").presentFields()).isEmpty();
    }

    @Test
    void empty_field_values_are_absent() {
        ParsedProfile parsed = parse(file("# Identity\n- name:\n- role:    \n- gallery_lead:\n"));
        assertThat(parsed.problems()).isEmpty();
        assertThat(section(parsed, "identity").patch().isEmpty()).isTrue();
    }

    @Test
    void field_names_ignore_case_and_read_spaces_and_hyphens_as_underscores() {
        ParsedProfile parsed = parse(file("# Now\n- Last Updated: 2026-01-01\n# Identity\n- GALLERY-LEAD: x\n"));
        assertThat(parsed.problems()).isEmpty();
        assertThat(section(parsed, "now").patch()).isEqualTo(json("{\"lastUpdated\": \"2026-01-01\"}"));
        assertThat(section(parsed, "identity").patch()).isEqualTo(json("{\"galleryLead\": \"x\"}"));
    }

    @Test
    void the_field_value_is_everything_after_the_first_colon() {
        ParsedProfile parsed = parse(file("# Contact\n- github:   https://example.com/a:b  \n"));
        assertThat(section(parsed, "contact").patch()).isEqualTo(json("{\"github\": \"https://example.com/a:b\"}"));
    }

    @Test
    void headings_match_ignoring_case_and_runs_of_spaces() {
        ParsedProfile parsed = parse(file("#   career    GOALS  \nText.\n# Now\n##   ITEMS\n- a\n"));
        assertThat(parsed.problems()).isEmpty();
        assertThat(section(parsed, "career-goals").patch()).isEqualTo(json("{\"seeking\": \"Text.\"}"));
        assertThat(section(parsed, "now").patch()).isEqualTo(json("{\"items\": [{\"text\": \"a\"}]}"));
    }

    @Test
    void a_hash_without_a_space_is_text_not_a_heading() {
        ParsedProfile parsed = parse(file("# Career goals\n#hashtag text\n"));
        assertThat(parsed.problems()).isEmpty();
        assertThat(section(parsed, "career-goals").patch()).isEqualTo(json("{\"seeking\": \"#hashtag text\"}"));
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "\\# Identity",
                "\\## Next",
                "\\- remote or hybrid",
                "\\* * *",
                "\\+ plus",
                "\\~~~ waves",
                "\\```js",
                "\\<!-- open to offers",
                "\\___",
                "\\\\ starts with a backslash"
            })
    void a_backslash_makes_a_paragraph_line_plain_text_and_is_removed(String line) {
        ParsedProfile parsed = parse(
                file("# Career goals\n" + line + "\n# About\n" + line + "\n## A {#a}\n" + line + "\n\n" + line + "\n"));

        String text = line.substring(1);
        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.sections()).hasSize(2);
        assertThat(section(parsed, "career-goals").patch().get("seeking").asString())
                .isEqualTo(text);
        JsonNode about = section(parsed, "about").patch();
        assertThat(about.get("intro").asString()).isEqualTo(text);
        assertThat(about.at("/sections").size()).isEqualTo(1);
        assertThat(about.at("/sections/0/body").size()).isEqualTo(2);
        assertThat(about.at("/sections/0/body/0").asString()).isEqualTo(text);
        assertThat(about.at("/sections/0/body/1").asString()).isEqualTo(text);
    }

    @Test
    void other_backslashes_and_backslashes_outside_paragraphs_stay_as_written() {
        ParsedProfile parsed = parse(file("# Career goals\n\\x and \\# inside\n# Site\n- name: \\# A\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(section(parsed, "career-goals").patch().get("seeking").asString())
                .isEqualTo("\\x and \\# inside");
        assertThat(section(parsed, "site").patch().get("name").asString()).isEqualTo("\\# A");
    }

    @Test
    void a_group_title_with_an_unbalanced_brace_but_no_block_is_plain_text() {
        ParsedProfile parsed = parse(file("# About\nIntro.\n## Notes {draft\nText.\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(section(parsed, "about").patch().at("/sections/0/title").asString())
                .isEqualTo("Notes {draft");
    }

    // ---- rows and groups ---------------------------------------------------------------------------------------

    @Test
    void empty_cells_are_filled_as_the_descriptor_says() {
        ParsedProfile parsed = parse(file("# Timeline\n## Entries\n- | Engineer\n- education | Degree | | | \n"));
        assertThat(parsed.problems()).isEmpty();
        assertThat(section(parsed, "timeline").patch()).isEqualTo(json("""
            {"entries": [
              {"kind": "", "title": "Engineer", "org": null, "period": null, "summary": ""},
              {"kind": "education", "title": "Degree", "org": null, "period": null, "summary": ""}]}\
            """));
    }

    @Test
    void a_missing_required_attribute_is_the_empty_value() {
        ParsedProfile parsed = parse(file("# Skills\n## Tools\n- Git\n"));
        assertThat(parsed.problems()).isEmpty();
        assertThat(section(parsed, "skills").patch()).isEqualTo(json("""
            {"groups": [{"title": "Tools", "id": "tools", "defaultLevel": "", "items": [{"name": "Git"}]}]}\
            """));
    }

    @Test
    void a_group_without_rows_has_an_empty_list() {
        ParsedProfile parsed = parse(file("# About\n## Empty {#empty}\n"));
        assertThat(section(parsed, "about").patch())
                .isEqualTo(json("{\"sections\": [{\"title\": \"Empty\", \"id\": \"empty\", \"body\": []}]}"));
    }

    @CsvSource(
            delimiter = ';',
            quoteCharacter = '"',
            value = {
                "a | b | c; a, b, c",
                "a \\| b | c; a | b, c",
                "a \\\\| b; a \\, b",
                "a \\\\\\| b; a \\| b",
                "a \\x \\ b; a \\x \\ b",
                "trailing \\; trailing \\",
                "\"  a  |  b  \"; a, b",
                "|; ,"
            })
    @ParameterizedTest
    void cells_split_on_unescaped_pipes(String row, String expected) {
        List<String> cells = expected.equals(",") ? List.of("", "") : List.of(expected.split(", ", -1));
        assertThat(ProfileMarkdownParser.splitCells(row)).containsExactlyElementsOf(cells);
    }

    @Test
    void field_values_have_no_escapes() {
        ParsedProfile parsed = parse(file("# Site\n- name: A \\| B \\\\ C\n"));
        assertThat(section(parsed, "site").patch()).isEqualTo(json("{\"name\": \"A \\\\| B \\\\\\\\ C\"}"));
    }

    @CsvSource(
            delimiter = ';',
            value = {
                "Backend; backend",
                "  Hello,   World!  ; hello-world",
                "C++ & Java; c-java",
                "Version 2.0; version-2-0",
                "---; ''",
                "K{1EF9} n{0103}ng; ky-nang",
                "{0110}{1EDD}i s{1ED1}ng; doi-song",
                "Ti{1EBF}ng Vi{1EC7}t c{01A1} b{1EA3}n; tieng-viet-co-ban",
                "Stra{00DF}e; stra-e"
            })
    @ParameterizedTest
    void group_ids_are_derived_from_titles(String title, String id) {
        String text = u(title);
        assertThat(ProfileMarkdownParser.deriveId(text)).isEqualTo(id);
        assertThat(ProfileMarkdownParser.deriveId(Normalizer.normalize(text, Normalizer.Form.NFD)))
                .isEqualTo(id);
    }

    @Test
    void derived_ids_are_cut_to_40_characters_without_a_trailing_hyphen() {
        assertThat(ProfileMarkdownParser.deriveId("a".repeat(60))).isEqualTo("a".repeat(40));
        assertThat(ProfileMarkdownParser.deriveId("a".repeat(39) + " bcd")).isEqualTo("a".repeat(39));
    }

    @Test
    void an_explicit_id_wins_over_the_derived_one() {
        ParsedProfile parsed = parse(file("# Skills\n## Backend {#server  level=worked-with }\n- Java\n"));
        assertThat(parsed.problems()).isEmpty();
        assertThat(section(parsed, "skills").patch()).isEqualTo(json("""
            {"groups": [{"title": "Backend", "id": "server", "defaultLevel": "worked-with",
                         "items": [{"name": "Java"}]}]}\
            """));
    }

    @Test
    void rows_and_groups_replace_whole_lists_only_when_present() {
        ParsedProfile parsed = parse(file("# Now\n- intro: x\n## Items\n# Contact\n## Social links\n\n"));
        assertThat(parsed.problems()).isEmpty();
        assertThat(section(parsed, "now").patch()).isEqualTo(json("{\"intro\": \"x\"}"));
        assertThat(section(parsed, "contact").patch().isEmpty()).isTrue();
    }

    @Test
    void sections_keep_the_file_order() {
        ParsedProfile parsed = parse(file("# Blogroll\n# Site\n# About\n"));
        assertThat(parsed.sections()).extracting(s -> s.descriptor().id()).containsExactly("blogroll", "site", "about");
    }
}
