package com.blog.siteimport.format;

import com.blog.sitecontent.schema.SiteContentKey;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * The downloadable template: front matter, instructions for an AI assistant, then every section filled from the
 * packaged example document of the language ({@code site-import/defaults-<locale>.json}) and annotated.
 */
@Component
public class TemplateGenerator {

    private static final String RESOURCE = "site-import/defaults-%s.json";
    private static final String FALLBACK_LOCALE = "en";
    private static final JsonMapper MAPPER = JsonMapper.builder().build();

    /** A short neutral body for the About page section; it uses one article block (a callout, 3 colons). */
    private static final String ABOUT_BODY_EXAMPLE = """
            Write the story of the site here, as Markdown. This text is an example: replace it.

            ## What this page covers

            Say in a few sentences who the site is for and what readers find on it.

            :::callout{type="tip" title="Blocks work here"}
            The blocks of an article (callouts, metrics, timelines, tabs and more) can be used on this page.
            :::
            """.strip();

    /** The locale is a language code such as {@code vi}; the caller has checked that the site enables it. */
    public String template(String locale) {
        if (!locale.matches("[a-z]{2,8}")) {
            throw new IllegalArgumentException("locale must be a lower-case language code");
        }
        return ProfileMarkdownWriter.frontMatter(locale)
                + "\n"
                + ProfileMarkdownWriter.comment(instructions(locale))
                + "\n\n"
                + ProfileMarkdownWriter.sections(examples(locale), true);
    }

    private static List<String> instructions(String locale) {
        String language = Locale.forLanguageTag(locale).getDisplayLanguage(Locale.ENGLISH);
        List<String> lines = new ArrayList<>(List.of(
                "INSTRUCTIONS FOR AN AI ASSISTANT",
                "Fill this site profile file (language: " + language + ", locale: " + locale + ") from the material",
                "the owner gives you, such as a CV or notes. Follow these rules exactly.",
                "",
                "1. Use only facts that are in the material. When a fact is unknown, leave the value empty;",
                "   never invent it.",
                "2. Never invent numbers, dates, employers or links. Every measurement or number you write must come",
                "   from the material, and any measurement needs a named source.",
                "3. Leave out sensitive data (phone number, home address, ID numbers) unless the owner explicitly",
                "   wants it public.",
                "4. Keep the headings, the field names and the structure exactly. Do not add sections or fields.",
                "5. No HTML, no scripts, no code fences and no extra front matter keys. Keep schema_version: 1,",
                "   content_type: site-profile and locale: " + locale + ".",
                "6. URLs must start with https:// (or mailto: where the field says so).",
                "7. One value per line. Respect the limits written next to each field.",
                "8. Leave the photo of the About section and the logo of a Timeline entry empty unless the owner gives an",
                "   image. An image is a path under assets/ (JPEG, PNG or WebP) and needs a ZIP package: the one .md file",
                "   and an assets/ folder with the images, imported as a .zip. A plain .md file cannot carry images.",
                "9. A Timeline entry is a heading such as \"## Title {kind=experience}\" (or kind=education) followed by one",
                "   \"- name: value\" line per detail. Write the technologies on one line, \"- tech: Java | Spring Boot\", and",
                "   write \"- highlight: ...\" once per achievement. Leave a detail empty when it is unknown.",
                "10. Return only the finished file, nothing before or after it."));
        if (!"en".equals(locale)) {
            lines.add("");
            lines.add("Write every text value in " + language + ".");
        }
        return lines;
    }

    private static Map<SiteContentKey, JsonNode> examples(String locale) {
        JsonNode document = load(locale);
        Map<SiteContentKey, JsonNode> payloads = new EnumMap<>(SiteContentKey.class);
        for (SiteContentKey key : SiteContentKey.values()) {
            JsonNode payload = document.at("/sections/" + key.key() + "/payload");
            if (payload.isObject()) {
                payloads.put(key, key == SiteContentKey.ABOUT ? withExampleBody((ObjectNode) payload) : payload);
            }
        }
        return payloads;
    }

    /** The About payload of the packaged example plus the example body; the packaged defaults themselves have none. */
    private static JsonNode withExampleBody(ObjectNode about) {
        if (about.has("body")) {
            return about;
        }
        ObjectNode copy = about.deepCopy();
        copy.put("body", ABOUT_BODY_EXAMPLE);
        return copy;
    }

    private static JsonNode load(String locale) {
        ClassPathResource resource = new ClassPathResource(RESOURCE.formatted(locale));
        if (!resource.exists()) {
            resource = new ClassPathResource(RESOURCE.formatted(FALLBACK_LOCALE));
        }
        try (InputStream in = resource.getInputStream()) {
            return MAPPER.readTree(in);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
