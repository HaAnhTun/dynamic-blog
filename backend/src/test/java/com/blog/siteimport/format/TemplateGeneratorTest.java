package com.blog.siteimport.format;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assumptions.assumeThat;

import com.blog.sitecontent.schema.SiteContentKey;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

class TemplateGeneratorTest {

    private static final Path FRONTEND_DEFAULTS = Path.of("..", "frontend", "content", "defaults");
    private static final List<SiteContentKey> FORMAT_KEYS = List.of(
            SiteContentKey.SITE,
            SiteContentKey.PROFILE,
            SiteContentKey.ABOUT,
            SiteContentKey.SKILLS,
            SiteContentKey.NOW,
            SiteContentKey.TIMELINE,
            SiteContentKey.CONTACT,
            SiteContentKey.BLOGROLL);

    private final TemplateGenerator generator = new TemplateGenerator();

    @ParameterizedTest
    @ValueSource(strings = {"en", "vi"})
    void the_packaged_examples_equal_the_frontend_defaults(String locale) throws IOException {
        assumeThat(Files.isDirectory(FRONTEND_DEFAULTS))
                .as("the frontend defaults folder")
                .isTrue();
        JsonNode document = ProfileRoundTrip.readResource("site-import/defaults-" + locale + ".json");

        assertThat(document.get("format").asString()).isEqualTo("site-content");
        assertThat(document.get("locale").asString()).isEqualTo(locale);
        assertThat(document.get("sections").size()).isEqualTo(FORMAT_KEYS.size());
        for (SiteContentKey key : FORMAT_KEYS) {
            Path file = FRONTEND_DEFAULTS.resolve(locale).resolve(key.key() + ".json");
            JsonNode expected = ProfileRoundTrip.MAPPER.readTree(Files.readString(file));
            JsonNode section = document.get("sections").get(key.key());

            assertThat(section.get("schemaVersion").asInt()).isEqualTo(1);
            assertThat(section.get("payload"))
                    .as("backend/src/main/resources/site-import/defaults-%s.json, %s: copy %s"
                            .formatted(locale, key.key(), file))
                    .isEqualTo(expected);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"en", "vi"})
    void the_template_parses_without_problems_and_imports_to_the_packaged_defaults(String locale) {
        String template = generator.template(locale);

        ParsedProfile parsed = ProfileMarkdownParser.parse(template);

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored()).isEmpty();
        assertThat(parsed.locale()).isEqualTo(locale);
        assertThat(parsed.sections()).hasSize(SectionRegistry.sections().size());
        Map<SiteContentKey, JsonNode> imported = ProfileRoundTrip.importFile(template);
        ObjectNode about = ((ObjectNode) imported.get(SiteContentKey.ABOUT)).deepCopy();
        assertThat(about.get("body").asString())
                .as("the example About page body")
                .isNotBlank();
        about.remove("body");
        Map<SiteContentKey, JsonNode> withoutBody = new EnumMap<>(imported);
        withoutBody.put(SiteContentKey.ABOUT, about);
        assertThat(withoutBody).hasSize(FORMAT_KEYS.size()).isEqualTo(ProfileRoundTrip.packagedDefaults(locale));
    }

    @ParameterizedTest
    @ValueSource(strings = {"en", "vi"})
    void the_template_is_annotated_and_carries_the_instructions_for_an_assistant(String locale) {
        String template = generator.template(locale);

        assertThat(template)
                .startsWith("---\nschema_version: 1\ncontent_type: site-profile\nlocale: " + locale + "\n---\n")
                .endsWith("\n")
                .contains("INSTRUCTIONS FOR AN AI ASSISTANT")
                .contains("(required):", "(optional):")
                .contains("Never invent numbers, dates, employers or links")
                .contains("any measurement needs a named source")
                .contains("Use only facts that are in the material")
                .contains("leave the value empty")
                .contains("sensitive data (phone number, home address, ID numbers)")
                .contains("Do not add sections or fields")
                .contains("No HTML, no scripts, no code fences and no extra front matter keys")
                .contains("Keep schema_version: 1", "content_type: site-profile")
                .contains("URLs must start with https://", "mailto:")
                .contains("One value per line", "Respect the limits")
                .contains("Return only the finished file");
        assertThat(template.split("<!--", -1).length - 1)
                .as("each comment is closed")
                .isEqualTo(template.split("-->", -1).length - 1);
    }

    @Test
    void only_the_vietnamese_template_asks_for_vietnamese_text() {
        assertThat(generator.template("vi"))
                .contains("language: Vietnamese")
                .contains("Write every text value in Vietnamese.");
        assertThat(generator.template("en")).contains("language: English").doesNotContain("Write every text value in");
    }

    @Test
    void the_lists_that_are_empty_in_the_examples_get_a_commented_example_row() {
        String template = generator.template("en");

        assertThat(template)
                .contains("## Social links\n\n<!--\nExample row")
                .contains("- Example label | https://example.com/")
                .contains("# Blogroll")
                .contains("- Example name | https://example.com/");
    }

    @Test
    void a_locale_without_packaged_examples_falls_back_to_the_english_ones() {
        String template = generator.template("fr");

        assertThat(template).contains("locale: fr").contains("- name: Your Site Name");
    }

    @Test
    void a_locale_that_is_not_a_language_code_is_refused() {
        assertThatThrownBy(() -> generator.template("../en")).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> generator.template("en\n---")).isInstanceOf(IllegalArgumentException.class);
    }
}
