package com.blog.sitecontent.schema;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.validation.Validation;
import jakarta.validation.Validator;
import java.util.List;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The optional details of a timeline entry (link, location, department, highlights, technologies, logo): each is left out
 * when absent, older entries without them stay valid, and every limit names the offending pointer.
 */
class TimelineEntryDetailsSchemaTest {

    private static final Validator VALIDATOR =
            Validation.buildDefaultValidatorFactory().getValidator();

    private static final String LOGO = "/media/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.png";

    private final SiteContentSchemas schemas = new SiteContentSchemas(VALIDATOR, new SiteContentUpgrades());

    private static ObjectNode timeline() {
        return SiteContentSchemasTest.fixture(SiteContentKey.TIMELINE);
    }

    private static ObjectNode first(ObjectNode payload) {
        return (ObjectNode) payload.get("entries").get(0);
    }

    private List<String> problems(Consumer<ObjectNode> edit) {
        ObjectNode payload = timeline();
        edit.accept(first(payload));
        return schemas.check(SiteContentKey.TIMELINE, 1, payload, "").problems();
    }

    private static String repeat(int length) {
        return "a".repeat(length);
    }

    @Test
    void entries_without_any_detail_stay_valid_and_are_stored_without_them() {
        ObjectNode payload = timeline();

        SiteContentSchemas.Checked checked = schemas.check(SiteContentKey.TIMELINE, 1, payload, "");

        assertThat(checked.problems()).isEmpty();
        assertThat(checked.payload()).isEqualTo(payload);
        assertThat(first((ObjectNode) checked.payload()).propertyNames())
                .containsExactlyInAnyOrder("kind", "title", "org", "period", "summary");
    }

    @Test
    void every_detail_is_accepted_and_kept_as_written() {
        ObjectNode payload = timeline();
        ObjectNode entry = first(payload);
        entry.put("url", "https://example.com/team");
        entry.put("location", "Example City");
        entry.put("department", "Platform");
        entry.putArray("highlights").add("Shipped a thing.").add("Measured it.");
        entry.putArray("tech").add("Java").add("PostgreSQL");
        entry.put("logo", LOGO);

        SiteContentSchemas.Checked checked = schemas.check(SiteContentKey.TIMELINE, 1, payload, "");

        assertThat(checked.problems()).isEmpty();
        assertThat(checked.payload()).isEqualTo(payload);
    }

    @Test
    void empty_lists_are_normalized_away() {
        ObjectNode payload = timeline();
        first(payload).putArray("highlights");
        first(payload).putArray("tech");

        SiteContentSchemas.Checked checked = schemas.check(SiteContentKey.TIMELINE, 1, payload, "");

        assertThat(checked.problems()).isEmpty();
        assertThat(first((ObjectNode) checked.payload()).has("highlights")).isFalse();
        assertThat(first((ObjectNode) checked.payload()).has("tech")).isFalse();
    }

    @Test
    void the_link_must_be_an_https_address() {
        assertThat(problems(e -> e.put("url", "http://example.com"))).anyMatch(p -> p.startsWith("/entries/0/url: "));
        assertThat(problems(e -> e.put("url", "javascript:alert(1)"))).anyMatch(p -> p.startsWith("/entries/0/url: "));
        assertThat(problems(e -> e.put("url", "/relative"))).anyMatch(p -> p.startsWith("/entries/0/url: "));
        assertThat(problems(e -> e.put("url", ""))).anyMatch(p -> p.startsWith("/entries/0/url: "));
        assertThat(problems(e -> e.put("url", "https://example.com/" + repeat(300))))
                .anyMatch(p -> p.startsWith("/entries/0/url: "));
    }

    @Test
    void location_and_department_are_at_most_80_characters_and_not_empty() {
        assertThat(problems(e -> e.put("location", repeat(80)))).isEmpty();
        assertThat(problems(e -> e.put("location", repeat(81)))).anyMatch(p -> p.startsWith("/entries/0/location: "));
        assertThat(problems(e -> e.put("location", ""))).anyMatch(p -> p.startsWith("/entries/0/location: "));
        assertThat(problems(e -> e.put("department", repeat(80)))).isEmpty();
        assertThat(problems(e -> e.put("department", repeat(81))))
                .anyMatch(p -> p.startsWith("/entries/0/department: "));
        assertThat(problems(e -> e.put("department", " padded")))
                .anyMatch(p -> p.startsWith("/entries/0/department: "));
    }

    @Test
    void at_most_12_highlights_of_at_most_300_characters() {
        assertThat(problems(e -> fill(e.putArray("highlights"), 12, repeat(300))))
                .isEmpty();
        assertThat(problems(e -> fill(e.putArray("highlights"), 13, "x")))
                .anyMatch(p -> p.startsWith("/entries/0/highlights: "));
        assertThat(problems(e -> fill(e.putArray("highlights"), 1, repeat(301))))
                .anyMatch(p -> p.startsWith("/entries/0/highlights/0: "));
        assertThat(problems(e -> fill(e.putArray("highlights"), 1, "")))
                .anyMatch(p -> p.startsWith("/entries/0/highlights/0: "));
    }

    @Test
    void at_most_30_technologies_of_at_most_40_characters() {
        assertThat(problems(e -> fill(e.putArray("tech"), 30, repeat(40)))).isEmpty();
        assertThat(problems(e -> fill(e.putArray("tech"), 31, "x"))).anyMatch(p -> p.startsWith("/entries/0/tech: "));
        assertThat(problems(e -> fill(e.putArray("tech"), 1, repeat(41))))
                .anyMatch(p -> p.startsWith("/entries/0/tech/0: "));
    }

    @Test
    void the_logo_is_an_uploaded_image_path_like_the_avatar() {
        assertThat(problems(e -> e.put("logo", LOGO))).isEmpty();
        for (String bad : new String[] {"assets/logo.png", "https://example.com/logo.png", "/media/x.png", ""}) {
            assertThat(problems(e -> e.put("logo", bad))).as(bad).anyMatch(p -> p.startsWith("/entries/0/logo: "));
        }
    }

    @Test
    void a_detail_that_is_not_a_text_is_a_problem_and_an_unknown_detail_is_not_a_property() {
        assertThat(problems(e -> e.put("location", 5))).anyMatch(p -> p.startsWith("/entries/0/location: "));
        assertThat(problems(e -> e.putArray("tech").add(7))).anyMatch(p -> p.startsWith("/entries/0/tech/0: "));
        assertThat(problems(e -> e.put("website", "https://example.com/")))
                .anyMatch(p -> p.startsWith("/entries/0/website: "));
    }

    private static void fill(ArrayNode array, int count, String value) {
        for (int i = 0; i < count; i++) {
            array.add(value);
        }
    }
}
