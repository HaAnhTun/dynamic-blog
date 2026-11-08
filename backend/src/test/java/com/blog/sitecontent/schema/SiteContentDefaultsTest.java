package com.blog.sitecontent.schema;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assumptions.assumeThat;

import jakarta.validation.Validation;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The packaged defaults of the frontend ({@code frontend/content/defaults/<locale>/<key>.json}) are what a fresh
 * site shows, so each one must be a payload the backend would accept at version 1. Skipped when the frontend folder is
 * not next to the backend module.
 */
class SiteContentDefaultsTest {

    private static final Path DEFAULTS = Path.of("..", "frontend", "content", "defaults");
    private static final List<String> LOCALES = List.of("en", "vi");

    private final SiteContentSchemas schemas =
            new SiteContentSchemas(Validation.buildDefaultValidatorFactory().getValidator(), new SiteContentUpgrades());

    @ParameterizedTest
    @EnumSource(SiteContentKey.class)
    void every_packaged_default_is_a_valid_version_1_payload(SiteContentKey key) throws Exception {
        assumeThat(Files.isDirectory(DEFAULTS))
                .as("the frontend defaults folder")
                .isTrue();
        JsonMapper mapper = JsonMapper.builder().build();
        for (String locale : LOCALES) {
            Path file = DEFAULTS.resolve(locale).resolve(key.key() + ".json");
            assertThat(file).as(file.toString()).isRegularFile();

            JsonNode payload = mapper.readTree(Files.readString(file));
            SiteContentSchemas.Checked checked = schemas.check(key, 1, payload, "");

            assertThat(checked.problems()).as(locale + "/" + key.key()).isEmpty();
        }
    }
}
