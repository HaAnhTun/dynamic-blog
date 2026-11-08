package com.blog.post.dto;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.validation.constraints.Size;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The limits of the text of a post are written in three places: the request records ({@code @Size}), the post file format and the
 * CHECK constraints of V46 (SQL, which cannot read a Java constant). This keeps them equal (issue 013).
 */
class PostLimitsTest {

    private static final Path MIGRATION =
            Path.of("src", "main", "resources", "db", "migration", "V46__limit_post_text_size.sql");

    /** {@code @Size} on a record component lands on its field (and constructor parameter), not on the component itself. */
    private static int sizeOf(Class<? extends Record> request, String component) throws NoSuchFieldException {
        return request.getDeclaredField(component).getAnnotation(Size.class).max();
    }

    @Test
    void the_request_records_use_the_shared_limits() throws NoSuchFieldException {
        for (Class<? extends Record> request : List.of(PostCreateRequest.class, PostUpdateRequest.class)) {
            assertThat(sizeOf(request, "title")).as(request.getSimpleName()).isEqualTo(PostLimits.TITLE_MAX);
            assertThat(sizeOf(request, "excerpt")).as(request.getSimpleName()).isEqualTo(PostLimits.EXCERPT_MAX);
            assertThat(sizeOf(request, "content")).as(request.getSimpleName()).isEqualTo(PostLimits.CONTENT_MAX);
        }
    }

    @Test
    void the_numbers_are_the_documented_ones() {
        assertThat(PostLimits.TITLE_MAX).isEqualTo(255);
        assertThat(PostLimits.EXCERPT_MAX).isEqualTo(1_000);
        assertThat(PostLimits.CONTENT_MAX).isEqualTo(500_000);
    }

    @Test
    void the_check_constraints_of_the_migration_repeat_the_same_numbers() throws IOException {
        String sql = Files.readString(MIGRATION, StandardCharsets.UTF_8);

        assertThat(sql).contains("char_length(content) <= " + PostLimits.CONTENT_MAX);
        assertThat(sql).contains("char_length(excerpt) <= " + PostLimits.EXCERPT_MAX);
        // The validation block tests the same numbers.
        assertThat(sql).contains("char_length(content) > " + PostLimits.CONTENT_MAX);
        assertThat(sql).contains("char_length(excerpt) > " + PostLimits.EXCERPT_MAX);
    }
}
