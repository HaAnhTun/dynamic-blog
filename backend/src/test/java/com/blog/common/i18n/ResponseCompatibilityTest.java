package com.blog.common.i18n;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.category.dto.CategoryResponse;
import com.blog.tag.dto.TagResponse;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** Backward compatibility of the taxonomy JSON: the old keys stay (null included), the new map appears only when filled. */
class ResponseCompatibilityTest {

    private final JsonMapper mapper = JsonMapper.builder().build();

    @Test
    void a_public_category_keeps_a_null_description_and_has_no_translations_key() {
        JsonNode json = mapper.valueToTree(new CategoryResponse(UUID.randomUUID(), "Name", "name", null));

        assertThat(json.has("description")).isTrue();
        assertThat(json.get("description").isNull()).isTrue();
        assertThat(json.has("translations")).isFalse();
    }

    @Test
    void an_admin_category_and_tag_carry_the_translations_map() {
        Map<String, LocalizedText> translations = Map.of("en", new LocalizedText("Name", null));

        JsonNode category =
                mapper.valueToTree(new CategoryResponse(UUID.randomUUID(), "Ten", "ten", null, translations));
        JsonNode tag = mapper.valueToTree(new TagResponse(UUID.randomUUID(), "Ten", "ten", translations));

        assertThat(category.get("translations").get("en").get("name").asString())
                .isEqualTo("Name");
        assertThat(tag.get("translations").get("en").get("name").asString()).isEqualTo("Name");
    }

    @Test
    void a_public_tag_has_no_translations_key() {
        assertThat(mapper.valueToTree(new TagResponse(UUID.randomUUID(), "Name", "name"))
                        .has("translations"))
                .isFalse();
    }
}
