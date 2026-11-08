package com.blog.siteimport.format;

import static com.blog.siteimport.format.ProfileMarkdownParserTest.file;
import static com.blog.siteimport.format.ProfileMarkdownParserTest.json;
import static com.blog.siteimport.format.ProfileMarkdownParserTest.section;
import static com.blog.siteimport.format.ProfileMarkdownParserTest.u;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.siteimport.format.ParsedProfile.ParsedSection;
import com.blog.siteimport.format.ParsedProfile.Problem;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Random;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpStatus;
import tools.jackson.databind.JsonNode;

/**
 * The file is untrusted: limits hold before parsing, nothing of YAML or HTML is interpreted, the work stays linear, and no
 * problem message repeats a value from the file. Ends with a deterministic fuzz over real fragments and garbage.
 */
class ProfileMarkdownParserSecurityTest {

    private static final String MARK = "QQMARKQQ";

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static ParsedProfile decodeAndParse(byte[] bytes) {
        return ProfileMarkdownParser.parse(ProfileFile.decode(bytes));
    }

    private static void assertNoEcho(ParsedProfile parsed, String marker) {
        assertThat(parsed.problems()).extracting(Problem::message).noneMatch(m -> m.contains(marker));
    }

    // ---- limits before parsing ---------------------------------------------------------------------------------

    @Test
    void binary_content_is_rejected_by_decode() {
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n', 0, 0, 0, 0x0D};
        assertThatThrownBy(() -> ProfileFile.decode(png))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.SITE_IMPORT_INVALID_FILE));
    }

    @Test
    void a_nul_byte_is_rejected_by_decode() {
        byte[] bytes = utf8(file("# Site\n- name: A?B\n"));
        bytes[bytes.length - 3] = 0;
        assertThatThrownBy(() -> ProfileFile.decode(bytes)).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(ErrorCode.SITE_IMPORT_INVALID_FILE);
            assertThat(e.getMessage()).contains("line 7");
        });
    }

    @Test
    void an_oversized_file_is_rejected_with_413_before_parsing() {
        byte[] bytes = utf8(file("# Site\n- name: " + "a".repeat(ProfileFile.MAX_BYTES) + "\n"));
        assertThatThrownBy(() -> ProfileFile.decode(bytes)).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(ErrorCode.VALIDATION_ERROR);
            assertThat(e.getStatus()).isEqualTo(HttpStatus.CONTENT_TOO_LARGE);
        });
    }

    @Test
    void a_three_million_character_line_is_rejected_by_decode_before_parse() {
        byte[] bytes = utf8(file("# Site\n- name: " + "x".repeat(3_000_000) + "\n"));
        assertTimeoutPreemptively(
                Duration.ofSeconds(2),
                () -> assertThatThrownBy(() -> decodeAndParse(bytes)).isInstanceOf(ApiException.class));
    }

    @Test
    void a_line_over_the_limit_inside_the_size_limit_is_rejected_by_decode() {
        byte[] bytes = utf8(file("# Site\n- name: " + MARK.repeat(1_000) + "\n"));
        assertThatThrownBy(() -> ProfileFile.decode(bytes)).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(ErrorCode.SITE_IMPORT_INVALID_FILE);
            assertThat(e.getMessage()).contains("Line 7").doesNotContain(MARK);
        });
    }

    // ---- linear work -------------------------------------------------------------------------------------------

    @Test
    void deep_nesting_of_100000_indented_bullets_finishes_fast_and_reports_problems() {
        StringBuilder body = new StringBuilder("# Now\n## Items\n- top\n");
        for (int i = 0; i < 100_000; i++) {
            body.append("  ".repeat(1 + i % 64)).append("- level ").append(i).append('\n');
        }
        String text = file(body.toString());
        ParsedProfile parsed =
                assertTimeoutPreemptively(Duration.ofSeconds(1), () -> ProfileMarkdownParser.parse(text));
        assertThat(parsed.problems()).hasSize(ProfileMarkdownParser.MAX_PROBLEMS + 1);
        assertThat(parsed.problems().getFirst().message()).isEqualTo("nested (indented) list items are not supported");
        assertThat(section(parsed, "now").patch()).isEqualTo(json("{\"items\": [{\"text\": \"top\"}]}"));
    }

    @Test
    void long_lines_full_of_special_characters_parse_in_linear_time() {
        String nasty = "\\|".repeat(1_900) + "{#".repeat(50) + "}";
        StringBuilder body = new StringBuilder("# Skills\n");
        for (int i = 0; i < 60; i++) {
            body.append("## ").append(nasty).append(" {#g").append(i).append(" level=learning}\n");
            body.append("- ").append(nasty).append('\n');
            body.append("<!-- ").append("<!--".repeat(900)).append('\n');
            body.append("-->".repeat(900)).append('\n');
        }
        String text = file(body.toString());
        ParsedProfile parsed =
                assertTimeoutPreemptively(Duration.ofSeconds(1), () -> ProfileMarkdownParser.parse(text));
        assertThat(parsed.sections()).hasSize(1);
    }

    @Test
    void a_full_size_file_of_empty_rows_gives_one_problem_and_at_most_100_items() {
        StringBuilder text = new StringBuilder(file("# Blogroll\n"));
        while (text.length() + 2 <= ProfileFile.MAX_BYTES) {
            text.append("-\n");
        }
        byte[] bytes = utf8(text.toString());
        assertThat(bytes.length).isGreaterThan(ProfileFile.MAX_BYTES - 2);

        ParsedProfile parsed = assertTimeoutPreemptively(Duration.ofSeconds(1), () -> decodeAndParse(bytes));

        assertThat(parsed.problems())
                .containsExactly(new Problem("blogroll", "entries", 107, "the list entries has more than 100 items"));
        ParsedSection blogroll = section(parsed, "blogroll");
        assertThat(blogroll.patch().get("entries").size()).isEqualTo(ProfileMarkdownParser.MAX_LIST_ITEMS);
        assertThat(blogroll.lines()).hasSizeLessThanOrEqualTo(4 * ProfileMarkdownParser.MAX_LIST_ITEMS + 2);
    }

    @Test
    void groups_and_the_rows_and_paragraphs_of_one_group_are_capped_too() {
        StringBuilder skills = new StringBuilder("# Skills\n## A {#a level=learning}\n" + "- x\n".repeat(150));
        for (int i = 0; i < 120; i++) {
            skills.append("## G").append(i).append(" {#g").append(i).append(" level=learning}\n- x\n");
        }
        String about = "# About\nIntro.\n## A {#a}\n" + "Paragraph.\n\n".repeat(150);

        ParsedProfile parsed = parse(file(skills + about));

        assertThat(parsed.problems())
                .extracting(Problem::message)
                .containsExactly(
                        "the list items has more than 100 items",
                        "the list groups has more than 100 items",
                        "the list body has more than 100 items");
        assertThat(section(parsed, "skills").patch().get("groups").size()).isEqualTo(100);
        assertThat(section(parsed, "skills").patch().at("/groups/0/items").size())
                .isEqualTo(100);
        assertThat(section(parsed, "about").patch().at("/sections/0/body").size())
                .isEqualTo(100);
    }

    // ---- inert text --------------------------------------------------------------------------------------------

    @Test
    void html_and_script_text_stay_inert_text() {
        String script = "<script>alert(1)</script>";
        String image = "<img src=x onerror=alert(1)> and <!-- not a comment -->";
        ParsedProfile parsed = parse(file("# Site\n- name: " + script + "\n# Career goals\n" + image + "\n"));
        assertThat(parsed.problems()).isEmpty();
        assertThat(section(parsed, "site").patch().get("name").asString()).isEqualTo(script);
        assertThat(section(parsed, "career-goals").patch().get("seeking").asString())
                .isEqualTo(image);
    }

    @Test
    void javascript_and_data_urls_pass_the_parser_as_plain_text() {
        ParsedProfile parsed = parse(file("""
            # Contact
            - github: javascript:alert(1)
            ## Social links
            - X | data:text/html;base64,PHNjcmlwdD4=
            # Blogroll
            - Y | javascript:alert(1)
            """));
        assertThat(parsed.problems()).isEmpty();
        assertThat(section(parsed, "contact").patch()).isEqualTo(json("""
            {"github": "javascript:alert(1)",
             "social": [{"label": "X", "url": "data:text/html;base64,PHNjcmlwdD4="}]}\
            """));
        assertThat(section(parsed, "blogroll").patch())
                .isEqualTo(json("{\"entries\": [{\"name\": \"Y\", \"url\": \"javascript:alert(1)\"}]}"));
    }

    @Test
    void no_field_outside_the_descriptors_can_be_set() {
        ParsedProfile parsed = parse(file("""
            # Identity
            - name: A
            - role_admin: true
            - password: x
            - __proto__: x
            - hero/headline: x
            # Security
            - role: ADMIN
            """));
        assertThat(section(parsed, "identity").patch()).isEqualTo(json("{\"name\": \"A\"}"));
        assertThat(parsed.ignoredTotal()).isEqualTo(5);
    }

    // ---- YAML is never interpreted -----------------------------------------------------------------------------

    @ParameterizedTest
    @ValueSource(
            strings = {
                "locale: &anchor vi",
                "locale: *anchor",
                "locale: !!str vi",
                "locale: !vi",
                "<<: *base",
                "<< : {locale: vi}",
                "locale: |",
                "locale: >-",
                "locale: [vi, en]",
                "locale: {lang: vi}",
                "  locale: vi",
                "\tlocale: vi",
                "locale: %vi",
                "locale: @vi",
                "locale: `vi`",
                "&a locale: vi",
                "*a: vi",
                "!tag locale: vi",
                "[locale]: vi"
            })
    void yaml_features_are_rejected_and_never_interpreted(String line) {
        String text = "---\nschema_version: 1\ncontent_type: site-profile\n" + line + "\n---\n# Site\n- name: A\n";
        ParsedProfile parsed = parse(text);
        assertThat(parsed.locale()).isNull();
        assertThat(parsed.problems()).anySatisfy(p -> {
            assertThat(p.message()).isEqualTo(ProfileMarkdownParser.YAML_MESSAGE);
            assertThat(p.line()).isEqualTo(4);
        });
    }

    @Test
    void a_second_document_is_rejected_and_never_read() {
        ParsedProfile parsed = parse(file("---\nschema_version: 2\n---\n# Site\n- name: A\n---\nlocale: vi\n"));
        assertThat(parsed.schemaVersion()).isEqualTo("1");
        assertThat(parsed.locale()).isEqualTo("en");
        assertThat(parsed.problems())
                .extracting(Problem::message)
                .contains(
                        "text before the first section heading is not allowed",
                        "a line of only ---, *** or ___ is not allowed",
                        "only - bullet lines are allowed here");
        assertThat(section(parsed, "site").patch()).isEqualTo(json("{\"name\": \"A\"}"));
    }

    @Test
    void front_matter_problems_never_echo_the_file() {
        ParsedProfile parsed =
                parse("---\n" + MARK + ": 1\nlocale: &" + MARK + "\n" + MARK + "\n  " + MARK + "\n---\n");
        assertThat(parsed.problems()).hasSizeGreaterThanOrEqualTo(4);
        assertNoEcho(parsed, MARK);
    }

    // ---- encodings ---------------------------------------------------------------------------------------------

    @Test
    void bom_crlf_and_cr_give_the_same_result_as_lf() {
        String text = u(ProfileMarkdownParserTest.file(ProfileMarkdownParserTest.FULL));
        ParsedProfile lf = decodeAndParse(utf8(text));
        ParsedProfile crlf = decodeAndParse(utf8((char) 0xFEFF + text.replace("\n", "\r\n")));
        ParsedProfile cr = decodeAndParse(utf8(text.replace("\n", "\r")));
        assertThat(lf.problems()).isEmpty();
        assertThat(crlf).isEqualTo(lf);
        assertThat(cr).isEqualTo(lf);
    }

    @Test
    void line_numbers_in_problems_count_crlf_lines() {
        ParsedProfile parsed = decodeAndParse(utf8(file("# Site\n### deep\n").replace("\n", "\r\n")));
        assertThat(parsed.problems()).extracting(Problem::line).containsExactly(7);
    }

    @Test
    void nfc_and_nfd_vietnamese_give_identical_patches() {
        String text = u(file("""
            # Identity
            - name: Nguy{1EC5}n V{0103}n A
            - location: H{00E0} N{1ED9}i
            # Skills
            ## K{1EF9} n{0103}ng m{1EC1}m {level=learning}
            - Giao ti{1EBF}p | worked-with | {0110}{1ED9}i nh{00F3}m
            """));
        String nfd = Normalizer.normalize(text, Normalizer.Form.NFD);
        assertThat(nfd).isNotEqualTo(text);
        ParsedProfile composed = decodeAndParse(utf8(text));
        ParsedProfile decomposed = decodeAndParse(utf8(nfd));
        assertThat(composed.problems()).isEmpty();
        assertThat(decomposed).isEqualTo(composed);
        assertThat(section(composed, "skills").patch().at("/groups/0/id").asString())
                .isEqualTo("ky-nang-mem");
    }

    // ---- fuzz --------------------------------------------------------------------------------------------------

    private static final List<String> FRAGMENTS = List.of(
            "---",
            "schema_version: 1",
            "content_type: site-profile",
            "locale: vi",
            "locale: &a vi",
            "<<: *a",
            "# Site",
            "# Identity",
            "# Career goals",
            "# About",
            "# Skills",
            "# Now",
            "# Timeline",
            "# Contact",
            "# Blogroll",
            "# Unknown " + MARK,
            "## Items",
            "## Entries",
            "## Social links",
            "## Group " + MARK + " {#g level=learning}",
            "## " + MARK + " {#bad_id x=y}",
            "## {#}",
            "### " + MARK,
            "- name: " + MARK,
            "- greeting: " + MARK,
            "- headline: x",
            "- last_updated: 2026-01-01",
            "- github: javascript:" + MARK,
            "- " + MARK + ": value",
            "- a | b | c",
            "- a \\| b | c \\\\ | d | e | f | g",
            "- | | |",
            "-",
            "  - nested " + MARK,
            "\t1. nested",
            "<!-- " + MARK,
            "-->",
            "<!-- x --> " + MARK,
            "```",
            "~~~",
            "***",
            "- - -",
            MARK + " paragraph text",
            "  continued " + MARK,
            "",
            "{#",
            "}",
            "|",
            "\\");

    private static final String GARBAGE = "#-|\\{}=:<>!-*&`~ \tabcXYZ019" + u("{0110}{1EC7}{00E9}{2028}{FEFF}");

    private static String randomText(Random random) {
        int lines = 1 + random.nextInt(40);
        StringBuilder out = new StringBuilder();
        if (random.nextInt(3) > 0) {
            out.append("---\nschema_version: 1\ncontent_type: site-profile\nlocale: en\n---\n");
        }
        for (int i = 0; i < lines; i++) {
            int pieces = 1 + random.nextInt(3);
            for (int p = 0; p < pieces; p++) {
                if (random.nextInt(3) == 0) {
                    int length = random.nextInt(12);
                    for (int c = 0; c < length; c++) {
                        out.append(GARBAGE.charAt(random.nextInt(GARBAGE.length())));
                    }
                } else {
                    out.append(FRAGMENTS.get(random.nextInt(FRAGMENTS.size())));
                }
            }
            out.append('\n');
        }
        return out.toString();
    }

    private static void collectLeaves(JsonNode node, String pointer, List<String> leaves) {
        if (node.isObject()) {
            for (Map.Entry<String, JsonNode> entry : node.properties()) {
                collectLeaves(entry.getValue(), pointer + "/" + entry.getKey(), leaves);
            }
        } else if (node.isArray()) {
            for (int i = 0; i < node.size(); i++) {
                collectLeaves(node.get(i), pointer + "/" + i, leaves);
            }
        } else {
            leaves.add(pointer);
        }
    }

    @ParameterizedTest
    @ValueSource(longs = {1L, 7L, 42L, 2026L})
    void fuzzed_input_never_throws_and_only_produces_descriptor_pointers(long seed) {
        Random random = new Random(seed);
        List<String> inputs = new ArrayList<>();
        for (int i = 0; i < 500; i++) {
            inputs.add(randomText(random));
        }
        assertTimeoutPreemptively(Duration.ofSeconds(5), () -> {
            for (String input : inputs) {
                ParsedProfile parsed = ProfileMarkdownParser.parse(input);
                assertNoEcho(parsed, MARK);
                assertThat(parsed.ignored()).hasSizeLessThanOrEqualTo(ProfileMarkdownParser.MAX_IGNORED);
                assertThat(parsed.problems()).hasSizeLessThanOrEqualTo(ProfileMarkdownParser.MAX_PROBLEMS + 1);
                for (ParsedSection section : parsed.sections()) {
                    List<String> leaves = new ArrayList<>();
                    collectLeaves(section.patch(), "", leaves);
                    for (String leaf : leaves) {
                        assertThat(SectionRegistry.fieldNameFor(section.descriptor(), leaf))
                                .as("%s in %s", leaf, section.descriptor().id())
                                .isNotNull();
                        assertThat(section.lines()).as(leaf).containsKey(leaf);
                    }
                }
            }
        });
    }

    private static ParsedProfile parse(String text) {
        return ProfileMarkdownParser.parse(text);
    }
}
