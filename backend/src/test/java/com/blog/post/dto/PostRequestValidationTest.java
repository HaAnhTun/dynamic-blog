package com.blog.post.dto;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.validation.ConstraintViolation;
import jakarta.validation.Validation;
import jakarta.validation.Validator;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

/**
 * The text of a post has a size limit at the edge: without it a backend reached directly accepts a body of the size of
 * the JSON parser's limit, and every public list loads and scans the full text of each post it shows.
 */
class PostRequestValidationTest {

    private static final Validator VALIDATOR =
            Validation.buildDefaultValidatorFactory().getValidator();

    private static final int CONTENT_MAX = 500_000;
    private static final int EXCERPT_MAX = 1_000;

    private static PostCreateRequest create(String excerpt, String content) {
        return new PostCreateRequest("Title", excerpt, content, null, null, null, null);
    }

    private static PostUpdateRequest update(String excerpt, String content) {
        return new PostUpdateRequest("Title", excerpt, content, null, null, null, null);
    }

    private static Set<String> invalidFields(Object request) {
        return VALIDATOR.validate(request).stream()
                .map(ConstraintViolation::getPropertyPath)
                .map(Object::toString)
                .collect(Collectors.toSet());
    }

    @Test
    void create_accepts_content_and_excerpt_at_the_limit() {
        assertThat(invalidFields(create("e".repeat(EXCERPT_MAX), "c".repeat(CONTENT_MAX))))
                .isEmpty();
    }

    @Test
    void create_rejects_content_over_the_limit() {
        assertThat(invalidFields(create("Excerpt", "c".repeat(CONTENT_MAX + 1))))
                .containsExactly("content");
    }

    @Test
    void create_rejects_an_excerpt_over_the_limit() {
        assertThat(invalidFields(create("e".repeat(EXCERPT_MAX + 1), "Content")))
                .containsExactly("excerpt");
    }

    @Test
    void create_accepts_a_missing_excerpt() {
        assertThat(invalidFields(create(null, "Content"))).isEmpty();
    }

    @Test
    void update_accepts_content_and_excerpt_at_the_limit() {
        assertThat(invalidFields(update("e".repeat(EXCERPT_MAX), "c".repeat(CONTENT_MAX))))
                .isEmpty();
    }

    @Test
    void update_rejects_content_over_the_limit() {
        assertThat(invalidFields(update("Excerpt", "c".repeat(CONTENT_MAX + 1))))
                .containsExactly("content");
    }

    @Test
    void update_rejects_an_excerpt_over_the_limit() {
        assertThat(invalidFields(update("e".repeat(EXCERPT_MAX + 1), "Content")))
                .containsExactly("excerpt");
    }

    @Test
    void update_accepts_a_missing_excerpt() {
        assertThat(invalidFields(update(null, "Content"))).isEmpty();
    }
}
