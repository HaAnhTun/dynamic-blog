package com.blog.sitecontent.schema;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.validation.Validation;
import jakarta.validation.Validator;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

/** The optional photo of the about content: an uploaded image path like the avatar, or nothing. */
class AboutPhotoSchemaTest {

    private static final Validator VALIDATOR =
            Validation.buildDefaultValidatorFactory().getValidator();

    private static final String PHOTO = "/media/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.jpg";

    private final SiteContentSchemas schemas = new SiteContentSchemas(VALIDATOR, new SiteContentUpgrades());

    private static ObjectNode about() {
        return SiteContentSchemasTest.fixture(SiteContentKey.ABOUT);
    }

    @Test
    void content_without_a_photo_stays_valid_and_is_stored_without_one() {
        ObjectNode payload = about();
        payload.remove("photo");

        SiteContentSchemas.Checked checked = schemas.check(SiteContentKey.ABOUT, 1, payload, "");

        assertThat(checked.problems()).isEmpty();
        assertThat(checked.payload().has("photo")).isFalse();
    }

    @Test
    void an_uploaded_image_path_is_kept() {
        ObjectNode payload = about();
        payload.put("photo", PHOTO);

        SiteContentSchemas.Checked checked = schemas.check(SiteContentKey.ABOUT, 1, payload, "");

        assertThat(checked.problems()).isEmpty();
        assertThat(checked.payload().get("photo").asString()).isEqualTo(PHOTO);
    }

    @Test
    void a_path_that_is_not_an_uploaded_image_is_a_problem() {
        for (String bad : new String[] {"assets/me.jpg", "https://example.com/me.jpg", "/media/x.jpg", ""}) {
            ObjectNode payload = about();
            payload.put("photo", bad);

            assertThat(schemas.check(SiteContentKey.ABOUT, 1, payload, "").problems())
                    .anyMatch(problem -> problem.startsWith("/photo"));
        }
    }
}
