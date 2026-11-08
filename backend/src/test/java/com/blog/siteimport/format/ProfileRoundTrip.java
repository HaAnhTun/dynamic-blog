package com.blog.siteimport.format;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.sitecontent.schema.SiteContentKey;
import com.blog.sitecontent.schema.SiteContentSchemas;
import com.blog.sitecontent.schema.SiteContentUpgrades;
import com.blog.siteimport.format.ParsedProfile.ParsedSection;
import jakarta.validation.Validation;
import java.io.IOException;
import java.io.InputStream;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.Map;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/** What the service does with a parsed file, reduced to what the format tests need: merge into the empty base, validate. */
final class ProfileRoundTrip {

    static final JsonMapper MAPPER = JsonMapper.builder().build();

    private static final SiteContentSchemas SCHEMAS =
            new SiteContentSchemas(Validation.buildDefaultValidatorFactory().getValidator(), new SiteContentUpgrades());

    private ProfileRoundTrip() {}

    /** Parses the file, fails when the parser reports a problem, merges each key and returns the validated payloads. */
    static Map<SiteContentKey, JsonNode> importFile(String markdown) {
        ParsedProfile parsed = ProfileMarkdownParser.parse(markdown);
        assertThat(parsed.problems()).as("parser problems").isEmpty();
        Map<SiteContentKey, ObjectNode> merged = new EnumMap<>(SiteContentKey.class);
        for (ParsedSection section : parsed.sections()) {
            ObjectNode target = merged.computeIfAbsent(section.descriptor().key(), SectionRegistry::createBase);
            Pointers.merge(target, section.patch());
        }
        Map<SiteContentKey, JsonNode> result = new EnumMap<>(SiteContentKey.class);
        merged.forEach((key, payload) -> result.put(key, normalized(key, payload)));
        return result;
    }

    /** The version 1 form of a payload, exactly what would be stored; fails the test when it is not valid. */
    static JsonNode normalized(SiteContentKey key, JsonNode payload) {
        SiteContentSchemas.Checked checked = SCHEMAS.check(key, 1, payload, "");
        assertThat(checked.problems()).as(key.key()).isEmpty();
        return checked.payload();
    }

    /** The packaged example payloads of a locale (the 8 keys of the format), normalized. */
    static Map<SiteContentKey, JsonNode> packagedDefaults(String locale) {
        JsonNode document = readResource("site-import/defaults-" + locale + ".json");
        Map<SiteContentKey, JsonNode> payloads = new LinkedHashMap<>();
        for (SiteContentKey key : SiteContentKey.values()) {
            JsonNode payload = document.at("/sections/" + key.key() + "/payload");
            if (payload.isObject()) {
                payloads.put(key, normalized(key, payload));
            }
        }
        return payloads;
    }

    static ObjectNode copy(JsonNode payload) {
        return (ObjectNode) payload.deepCopy();
    }

    static JsonNode readResource(String path) {
        try (InputStream in = ProfileRoundTrip.class.getClassLoader().getResourceAsStream(path)) {
            assertThat(in).as(path).isNotNull();
            return MAPPER.readTree(in);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
