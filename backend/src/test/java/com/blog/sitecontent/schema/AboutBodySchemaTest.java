package com.blog.sitecontent.schema;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.validation.Validation;
import jakarta.validation.Validator;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/** The optional Markdown body of the about content: the limits, the characters and the older content without it. */
class AboutBodySchemaTest {

    private static final JsonMapper MAPPER = JsonMapper.builder().build();
    private static final Validator VALIDATOR =
            Validation.buildDefaultValidatorFactory().getValidator();

    private final SiteContentSchemas schemas = new SiteContentSchemas(VALIDATOR, new SiteContentUpgrades());

    private List<String> problems(ObjectNode payload) {
        return schemas.check(SiteContentKey.ABOUT, 1, payload, "").problems();
    }

    private static ObjectNode about() {
        return SiteContentSchemasTest.fixture(SiteContentKey.ABOUT);
    }

    @Test
    void content_without_a_body_stays_valid_and_is_stored_without_one() {
        ObjectNode payload = about();
        payload.remove("body");

        SiteContentSchemas.Checked checked = schemas.check(SiteContentKey.ABOUT, 1, payload, "");

        assertThat(checked.problems()).isEmpty();
        assertThat(checked.payload().has("body")).isFalse();
    }

    @Test
    void a_body_with_line_breaks_and_tabs_is_stored_as_given() {
        ObjectNode payload = about();
        String body = "First line" + (char) 10 + (char) 9 + "indented" + (char) 13 + (char) 10 + "## Heading";
        payload.put("body", body);

        SiteContentSchemas.Checked checked = schemas.check(SiteContentKey.ABOUT, 1, payload, "");

        assertThat(checked.problems()).isEmpty();
        assertThat(checked.payload().get("body").asString()).isEqualTo(body);
    }

    @Test
    void an_empty_body_is_valid() {
        ObjectNode payload = about();
        payload.put("body", "");

        assertThat(problems(payload)).isEmpty();
    }

    @Test
    void a_body_of_exactly_the_limit_is_valid_and_one_more_character_is_not() {
        ObjectNode atLimit = about();
        atLimit.put("body", "a".repeat(20000));
        ObjectNode over = about();
        over.put("body", "a".repeat(20001));

        assertThat(problems(atLimit)).isEmpty();
        assertThat(problems(over)).containsExactly("/body: must be at most 20000 characters long");
    }

    @Test
    void a_control_character_other_than_a_line_break_or_a_tab_is_refused_without_echoing_it() {
        ObjectNode payload = about();
        payload.put("body", "text" + (char) 7 + "more");

        assertThat(problems(payload)).containsExactly("/body: must not contain control characters");
    }

    @Test
    void a_body_of_the_wrong_type_is_refused() {
        ObjectNode number = about();
        number.put("body", 5);
        ObjectNode list = about();
        list.putArray("body").add("x");

        assertThat(problems(number)).containsExactly("/body: has the wrong type");
        assertThat(problems(list)).hasSize(1);
        assertThat(problems(list).getFirst()).startsWith("/body");
    }

    @Test
    void the_fixture_without_a_body_still_binds_to_the_typed_record() throws Exception {
        ObjectNode payload = about();
        payload.remove("body");

        SiteContentTypes.About bean = MAPPER.treeToValue(payload, SiteContentTypes.About.class);

        assertThat(bean.body()).isNull();
    }
}
