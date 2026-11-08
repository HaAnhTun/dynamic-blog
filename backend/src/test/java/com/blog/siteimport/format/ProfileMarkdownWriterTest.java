package com.blog.siteimport.format;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.sitecontent.schema.SiteContentKey;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

class ProfileMarkdownWriterTest {

    /** Vietnamese letters built from code points: this file stays English-only for the language guard. */
    private static final String ACCENTS =
            new String(new int[] {0x54, 0xea, 0x6e, 0x20, 0x111, 0x1eb9, 0x70, 0x20, 0x1ea1, 0x1ec7}, 0, 10);

    @ParameterizedTest
    @ValueSource(strings = {"en", "vi"})
    void the_packaged_examples_survive_a_round_trip_plain_and_annotated(String locale) {
        Map<SiteContentKey, JsonNode> payloads = ProfileRoundTrip.packagedDefaults(locale);

        for (boolean annotated : new boolean[] {false, true}) {
            String file = ProfileMarkdownWriter.write(locale, payloads, annotated);

            assertThat(ProfileRoundTrip.importFile(file))
                    .as("annotated=" + annotated)
                    .isEqualTo(payloads);
        }
    }

    @Test
    void pipes_backslashes_accents_and_long_texts_survive_a_round_trip() {
        String longParagraph = "word ".repeat(199).strip();
        String intro = "word ".repeat(119).strip();
        Map<SiteContentKey, JsonNode> payloads = ProfileRoundTrip.packagedDefaults("en");
        ObjectNode contact = ProfileRoundTrip.copy(payloads.get(SiteContentKey.CONTACT));
        ArrayNode social = contact.putArray("social");
        social.addObject().put("label", "a | b").put("url", "https://example.com/a");
        social.addObject().put("label", "c\\d").put("url", "https://example.com/b");
        social.addObject().put("label", "e\\|f").put("url", "https://example.com/c");
        social.addObject().put("label", "g\\\\h\\").put("url", "https://example.com/d");
        social.addObject().put("label", ACCENTS).put("url", "mailto:name@example.com");
        contact.put("blurb", "Mail | or \\ write");
        ObjectNode about = ProfileRoundTrip.copy(payloads.get(SiteContentKey.ABOUT));
        about.put("intro", intro);
        ((ObjectNode) about.get("sections").get(0))
                .putArray("body")
                .add(longParagraph)
                .add(ACCENTS);
        ObjectNode blogroll = ProfileRoundTrip.copy(payloads.get(SiteContentKey.BLOGROLL));
        blogroll.putArray("entries")
                .addObject()
                .put("name", "Site | one")
                .put("url", "https://example.com/")
                .put("note", "note \\| with both");
        payloads.put(SiteContentKey.CONTACT, ProfileRoundTrip.normalized(SiteContentKey.CONTACT, contact));
        payloads.put(SiteContentKey.ABOUT, ProfileRoundTrip.normalized(SiteContentKey.ABOUT, about));
        payloads.put(SiteContentKey.BLOGROLL, ProfileRoundTrip.normalized(SiteContentKey.BLOGROLL, blogroll));

        String file = ProfileMarkdownWriter.write("en", payloads, false);

        assertThat(ProfileRoundTrip.importFile(file)).isEqualTo(payloads);
    }

    @ParameterizedTest
    @CsvSource(
            delimiter = ';',
            value = {
                "plain text;plain text",
                "a|b;a\\|b",
                "a\\b;a\\b",
                "a\\|b;a\\\\\\|b",
                "a\\\\b;a\\\\\\b",
                "trailing\\;trailing\\",
            })
    void a_cell_escapes_the_separator_and_only_the_backslashes_that_could_be_read_as_an_escape(
            String value, String expected) {
        assertThat(ProfileMarkdownWriter.escapeCell(value)).isEqualTo(expected);
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "# Looking for work",
                "# Identity",
                "# Skills",
                "## Next",
                "- remote or hybrid",
                "* star",
                "+ plus",
                "<!-- open to offers",
                "***",
                "* * *",
                "___",
                "---",
                "--- open",
                "```js",
                "~~~ waves",
                "\\ a backslash first",
                "\\# an escape typed by hand",
                "#hashtag"
            })
    void paragraphs_that_look_like_markdown_syntax_survive_a_round_trip(String value) {
        Map<SiteContentKey, JsonNode> payloads = ProfileRoundTrip.packagedDefaults("en");
        ObjectNode profile = ProfileRoundTrip.copy(payloads.get(SiteContentKey.PROFILE));
        profile.put("seeking", value);
        ObjectNode about = ProfileRoundTrip.copy(payloads.get(SiteContentKey.ABOUT));
        about.put("intro", value);
        ((ObjectNode) about.get("sections").get(0))
                .putArray("body")
                .add("First.")
                .add(value)
                .add("Third.");
        ((ArrayNode) about.get("sections"))
                .addObject()
                .put("id", "only")
                .put("title", "Only")
                .putArray("body")
                .add(value);
        payloads.put(SiteContentKey.PROFILE, ProfileRoundTrip.normalized(SiteContentKey.PROFILE, profile));
        payloads.put(SiteContentKey.ABOUT, ProfileRoundTrip.normalized(SiteContentKey.ABOUT, about));

        String file = ProfileMarkdownWriter.write("en", payloads, false);

        assertThat(ProfileRoundTrip.importFile(file)).isEqualTo(payloads);
    }

    @ParameterizedTest
    @CsvSource(
            delimiter = ';',
            value = {
                "plain;plain",
                "a # b;a # b",
                "# h;\\# h",
                "- b;\\- b",
                "* b;\\* b",
                "+ b;\\+ b",
                "~~~;\\~~~",
                "`x`;\\`x`",
                "<!--;\\<!--",
                "_x_;\\_x_",
                "\\x;\\\\x",
                "1. one;1. one",
            })
    void a_paragraph_gets_one_backslash_only_when_its_first_character_is_syntax(String value, String expected) {
        assertThat(ProfileMarkdownWriter.escapeParagraph(value)).isEqualTo(expected);
    }

    @Test
    void decomposed_text_is_written_in_nfc() {
        String decomposed = Normalizer.normalize(ACCENTS, Normalizer.Form.NFD);
        assertThat(decomposed).isNotEqualTo(ACCENTS);
        ObjectNode site =
                ProfileRoundTrip.copy(ProfileRoundTrip.packagedDefaults("en").get(SiteContentKey.SITE));
        site.put("name", decomposed);

        String file = ProfileMarkdownWriter.write("en", Map.of(SiteContentKey.SITE, site), false);

        assertThat(file).contains("\n- name: " + ACCENTS + "\n");
        assertThat(ProfileRoundTrip.importFile(file)
                        .get(SiteContentKey.SITE)
                        .path("name")
                        .asString())
                .isEqualTo(ACCENTS);
    }

    @Test
    void sections_without_a_payload_are_left_out_and_the_rest_keep_registry_order() {
        Map<SiteContentKey, JsonNode> all = ProfileRoundTrip.packagedDefaults("en");
        List<SiteContentKey> reversed = new ArrayList<>(all.keySet());
        Collections.reverse(reversed);
        Map<SiteContentKey, JsonNode> payloads = new LinkedHashMap<>();
        reversed.stream()
                .filter(key -> key != SiteContentKey.SKILLS && key != SiteContentKey.PROFILE)
                .forEach(key -> payloads.put(key, all.get(key)));

        String file = ProfileMarkdownWriter.write("en", payloads, false);

        assertThat(headings(file))
                .containsExactly("Site", "About", "Now", "Timeline", "Contact", "Blogroll")
                .doesNotContain("Skills", "Identity", "Career goals");
    }

    @Test
    void a_profile_payload_writes_both_of_its_sections_in_registry_order() {
        Map<SiteContentKey, JsonNode> defaults = ProfileRoundTrip.packagedDefaults("en");
        Map<SiteContentKey, JsonNode> payloads = new EnumMap<>(SiteContentKey.class);
        payloads.put(SiteContentKey.PROFILE, defaults.get(SiteContentKey.PROFILE));
        payloads.put(SiteContentKey.SITE, defaults.get(SiteContentKey.SITE));

        assertThat(headings(ProfileMarkdownWriter.write("en", payloads, false)))
                .containsExactly("Site", "Identity", "Career goals");
    }

    @Test
    void no_payload_gives_only_the_front_matter_and_the_output_ends_with_one_newline() {
        String empty = ProfileMarkdownWriter.write("vi", Map.of(), false);
        String full = ProfileMarkdownWriter.write("vi", ProfileRoundTrip.packagedDefaults("vi"), true);

        assertThat(empty).isEqualTo("---\nschema_version: 1\ncontent_type: site-profile\nlocale: vi\n---\n");
        assertThat(full).endsWith("\n").doesNotEndWith("\n\n").doesNotContain("\r");
        assertThat(full).startsWith(empty);
    }

    @Test
    void every_field_has_a_line_even_when_empty_and_groups_always_carry_an_id() {
        String file = ProfileMarkdownWriter.write("en", ProfileRoundTrip.packagedDefaults("en"), false);

        assertThat(file)
                .contains("\n- email:\n", "\n- github:\n", "\n## Who I am {#who}\n")
                .contains("\n## Backend {#backend level=used-in-project}\n");
    }

    @Test
    void rows_drop_only_trailing_empty_cells() {
        String file = ProfileMarkdownWriter.write("en", ProfileRoundTrip.packagedDefaults("en"), false);

        assertThat(file).contains("\n- Java\n", "\n- Docker | worked-with\n");
    }

    @Test
    void annotated_output_describes_each_section_and_the_plain_output_has_no_comment() {
        Map<SiteContentKey, JsonNode> payloads = ProfileRoundTrip.packagedDefaults("en");

        String annotated = ProfileMarkdownWriter.write("en", payloads, true);
        String plain = ProfileMarkdownWriter.write("en", payloads, false);

        assertThat(plain).doesNotContain("<!--").doesNotContain("-->");
        assertThat(annotated).contains("- name (required): ", "- tagline (optional): ", "column url (required): ");
        assertThat(annotated.split("<!--", -1).length - 1)
                .as("one comment under each heading plus the example rows of the 2 empty lists")
                .isEqualTo(headings(annotated).size() + 2);
        for (SectionDescriptor section : SectionRegistry.sections()) {
            assertThat(annotated).contains(section.description());
        }
    }

    @Test
    void a_line_break_inside_a_stored_value_never_adds_a_line_to_the_file() {
        ObjectNode site =
                ProfileRoundTrip.copy(ProfileRoundTrip.packagedDefaults("en").get(SiteContentKey.SITE));
        site.put("tagline", "first\nsecond\r\nthird");

        String file = ProfileMarkdownWriter.write("en", Map.of(SiteContentKey.SITE, site), false);

        assertThat(file).contains("\n- tagline: first second third\n");
    }

    private static List<String> headings(String file) {
        return file.lines()
                .filter(line -> line.startsWith("# "))
                .map(line -> line.substring(2))
                .toList();
    }
}
