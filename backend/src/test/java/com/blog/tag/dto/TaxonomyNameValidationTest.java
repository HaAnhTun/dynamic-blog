package com.blog.tag.dto;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.category.dto.CategoryRequest;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import org.junit.jupiter.api.Test;

/**
 * A tag or category name is one line of text: it reaches log lines, notifications and mail subjects, and creation is
 * open to an AUTHOR. A control character in it is refused at the request, not cleaned afterwards.
 */
class TaxonomyNameValidationTest {

    /** LF, CR, tab, NUL, DEL, a C1 control, the line separator and the paragraph separator. */
    private static final int[] REFUSED = {0x0A, 0x0D, 0x09, 0x00, 0x7F, 0x85, 0x2028, 0x2029};

    private final Validator validator =
            Validation.buildDefaultValidatorFactory().getValidator();

    private static String around(int codePoint) {
        return "a" + new String(Character.toChars(codePoint)) + "b";
    }

    @Test
    void a_tag_name_with_a_line_break_or_other_control_character_is_refused() {
        for (int c : REFUSED) {
            assertThat(validator.validate(new TagRequest(around(c))))
                    .as("U+%04X", c)
                    .hasSize(1);
        }
    }

    @Test
    void a_category_name_with_a_line_break_or_other_control_character_is_refused() {
        for (int c : REFUSED) {
            assertThat(validator.validate(new CategoryRequest(around(c), null)))
                    .as("U+%04X", c)
                    .hasSize(1);
        }
    }

    @Test
    void ordinary_names_pass() {
        assertThat(validator.validate(new TagRequest("Spring Boot 4"))).isEmpty();
        assertThat(validator.validate(new CategoryRequest("Back-end, and more", "A description\nover two lines")))
                .isEmpty();
    }
}
