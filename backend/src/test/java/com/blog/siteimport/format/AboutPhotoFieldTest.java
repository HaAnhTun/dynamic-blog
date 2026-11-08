package com.blog.siteimport.format;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.sitecontent.schema.SiteContentKey;
import com.blog.siteimport.format.ParsedProfile.ParsedSection;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/** The photo field of the About section: read from the file, written back, and named in the template. */
class AboutPhotoFieldTest {

    private static final String FRONT = "---\nschema_version: 1\ncontent_type: site-profile\nlocale: en\n---\n\n";
    private static final String MEDIA = "/media/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.png";

    private static ParsedSection about(ParsedProfile parsed) {
        return parsed.sections().stream()
                .filter(s -> s.descriptor().id().equals("about"))
                .findFirst()
                .orElseThrow();
    }

    @Test
    void a_photo_line_and_the_intro_paragraph_are_both_read() {
        ParsedProfile parsed =
                ProfileMarkdownParser.parse(FRONT + "# About\n\n- photo: assets/me.jpg\n\nHello there.\n");

        assertThat(parsed.problems()).isEmpty();
        ParsedSection section = about(parsed);
        assertThat(section.patch().get("photo").asString()).isEqualTo("assets/me.jpg");
        assertThat(section.patch().get("intro").asString()).isEqualTo("Hello there.");
        assertThat(section.presentFields()).contains("photo", "intro");
        assertThat(section.lines().get("/photo")).isEqualTo(9);
    }

    @Test
    void an_empty_photo_line_gives_no_photo() {
        ParsedProfile parsed = ProfileMarkdownParser.parse(FRONT + "# About\n\n- photo:\n\nHello there.\n");

        assertThat(parsed.problems()).isEmpty();
        assertThat(about(parsed).patch().has("photo")).isFalse();
    }

    @Test
    void an_uploaded_photo_path_is_exported_and_imports_back_unchanged() {
        Map<SiteContentKey, JsonNode> payloads = ProfileRoundTrip.packagedDefaults("en");
        ObjectNode about = ProfileRoundTrip.copy(payloads.get(SiteContentKey.ABOUT));
        about.put("photo", MEDIA);
        payloads.put(SiteContentKey.ABOUT, ProfileRoundTrip.normalized(SiteContentKey.ABOUT, about));

        String file = ProfileMarkdownWriter.write("en", payloads, false);

        assertThat(file).contains("- photo: " + MEDIA);
        assertThat(ProfileRoundTrip.importFile(file).get(SiteContentKey.ABOUT))
                .isEqualTo(payloads.get(SiteContentKey.ABOUT));
    }

    @Test
    void an_about_without_a_photo_exports_an_empty_photo_line_and_imports_back_unchanged() {
        Map<SiteContentKey, JsonNode> payloads = ProfileRoundTrip.packagedDefaults("en");

        String file = ProfileMarkdownWriter.write("en", payloads, false);

        assertThat(file).contains("- photo:\n");
        assertThat(ProfileRoundTrip.importFile(file).get(SiteContentKey.ABOUT))
                .isEqualTo(payloads.get(SiteContentKey.ABOUT));
    }

    @Test
    void the_template_mentions_the_photo_and_the_zip_package() {
        String template = new TemplateGenerator().template("en");

        assertThat(template).contains("- photo:").contains("ZIP").contains("assets/");
        assertThat(ProfileMarkdownParser.parse(template).problems()).isEmpty();
    }
}
