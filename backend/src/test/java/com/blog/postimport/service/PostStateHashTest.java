package com.blog.postimport.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** The state hash: stable, order free for tags, and different when any field the import keeps is different. */
class PostStateHashTest {

    private static final UUID CATEGORY = UUID.fromString("00000000-0000-0000-0000-0000000000c1");
    private static final UUID TAG_A = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    private static final UUID TAG_B = UUID.fromString("00000000-0000-0000-0000-0000000000b2");

    private static String hash(String title, String content, String slug, Instant publishedAt, List<UUID> tags) {
        return PostStateHash.of(title, "Excerpt", content, "en", slug, "DRAFT", publishedAt, CATEGORY, tags);
    }

    @Test
    void is_a_stable_lower_case_sha256() {
        String first = hash("Title", "Body\n", "slug", null, List.of(TAG_A, TAG_B));

        assertThat(first)
                .matches("[0-9a-f]{64}")
                .isEqualTo(hash("Title", "Body\n", "slug", null, List.of(TAG_A, TAG_B)));
    }

    @Test
    void does_not_depend_on_the_order_of_the_tags_or_on_the_normal_form_of_the_content() {
        assertThat(hash("Title", "Body\n", "slug", null, List.of(TAG_B, TAG_A)))
                .isEqualTo(hash("Title", "Body", "slug", null, List.of(TAG_A, TAG_B)))
                .isEqualTo(hash("Title", "\n\nBody\r\n\r\n", "slug", null, List.of(TAG_A, TAG_B)));
    }

    @Test
    void changes_with_every_field_it_covers() {
        String base = hash("Title", "Body", "slug", null, List.of(TAG_A));

        assertThat(hash("Other", "Body", "slug", null, List.of(TAG_A))).isNotEqualTo(base);
        assertThat(hash("Title", "Other", "slug", null, List.of(TAG_A))).isNotEqualTo(base);
        assertThat(hash("Title", "Body", "other", null, List.of(TAG_A))).isNotEqualTo(base);
        assertThat(hash("Title", "Body", "slug", Instant.parse("2026-01-01T00:00:00Z"), List.of(TAG_A)))
                .isNotEqualTo(base);
        assertThat(hash("Title", "Body", "slug", null, List.of(TAG_A, TAG_B))).isNotEqualTo(base);
        assertThat(hash("Title", "Body", "slug", null, List.of())).isNotEqualTo(base);
        assertThat(PostStateHash.of("Title", "Excerpt", "Body", "vi", "slug", "DRAFT", null, CATEGORY, List.of(TAG_A)))
                .isNotEqualTo(base);
        assertThat(PostStateHash.of(
                        "Title", "Excerpt", "Body", "en", "slug", "PUBLISHED", null, CATEGORY, List.of(TAG_A)))
                .isNotEqualTo(base);
        assertThat(PostStateHash.of("Title", "Excerpt", "Body", "en", "slug", "DRAFT", null, null, List.of(TAG_A)))
                .isNotEqualTo(base);
        assertThat(PostStateHash.of("Title", null, "Body", "en", "slug", "DRAFT", null, CATEGORY, List.of(TAG_A)))
                .isNotEqualTo(base);
    }

    private static final UUID SERIES = UUID.fromString("00000000-0000-0000-0000-0000000000d1");
    private static final UUID OTHER_SERIES = UUID.fromString("00000000-0000-0000-0000-0000000000d2");

    private static String inSeries(UUID series, Integer position, Integer part) {
        return PostStateHash.of(
                "Title",
                "Excerpt",
                "Body",
                "en",
                "slug",
                "DRAFT",
                null,
                CATEGORY,
                List.of(TAG_A),
                series,
                position,
                part);
    }

    @Test
    void a_post_outside_any_series_has_the_hash_it_had_before_series_were_part_of_it() {
        assertThat(inSeries(null, null, null)).isEqualTo(hash("Title", "Body", "slug", null, List.of(TAG_A)));
    }

    @Test
    void changes_with_the_series_the_position_and_the_declared_part() {
        String base = inSeries(SERIES, 2, 5);

        assertThat(base).isNotEqualTo(hash("Title", "Body", "slug", null, List.of(TAG_A)));
        assertThat(inSeries(OTHER_SERIES, 2, 5)).isNotEqualTo(base);
        assertThat(inSeries(SERIES, 3, 5)).isNotEqualTo(base);
        assertThat(inSeries(SERIES, 2, 6)).isNotEqualTo(base);
        assertThat(inSeries(SERIES, 2, null)).isNotEqualTo(base);
        assertThat(inSeries(SERIES, 2, 5)).isEqualTo(base);
    }

    @Test
    void cannot_be_made_to_collide_by_moving_text_between_fields() {
        assertThat(PostStateHash.of("ab", "c", "Body", "en", "s", "DRAFT", null, null, List.of()))
                .isNotEqualTo(PostStateHash.of("a", "bc", "Body", "en", "s", "DRAFT", null, null, List.of()));
    }

    @Test
    void covers_the_cover_and_its_description_only_for_a_post_that_has_one() {
        UUID series = UUID.fromString("00000000-0000-0000-0000-0000000000d1");
        UUID cover = UUID.fromString("00000000-0000-0000-0000-0000000000e1");
        UUID other = UUID.fromString("00000000-0000-0000-0000-0000000000e2");
        String none =
                PostStateHash.of("T", "E", "B", "en", "s", "DRAFT", null, CATEGORY, List.of(TAG_A), null, null, null);
        String covered = PostStateHash.of(
                "T", "E", "B", "en", "s", "DRAFT", null, CATEGORY, List.of(TAG_A), null, null, null, cover, "alt");

        assertThat(covered)
                .isNotEqualTo(none)
                .isNotEqualTo(PostStateHash.of(
                        "T",
                        "E",
                        "B",
                        "en",
                        "s",
                        "DRAFT",
                        null,
                        CATEGORY,
                        List.of(TAG_A),
                        null,
                        null,
                        null,
                        other,
                        "alt"))
                .isNotEqualTo(PostStateHash.of(
                        "T",
                        "E",
                        "B",
                        "en",
                        "s",
                        "DRAFT",
                        null,
                        CATEGORY,
                        List.of(TAG_A),
                        null,
                        null,
                        null,
                        cover,
                        "other"));
        assertThat(PostStateHash.of(
                        "T",
                        "E",
                        "B",
                        "en",
                        "s",
                        "DRAFT",
                        null,
                        CATEGORY,
                        List.of(TAG_A),
                        null,
                        null,
                        null,
                        null,
                        null))
                .isEqualTo(none);
        assertThat(PostStateHash.of(
                        "T", "E", "B", "en", "s", "DRAFT", null, CATEGORY, List.of(TAG_A), series, 1, 1, cover, "alt"))
                .isNotEqualTo(PostStateHash.of(
                        "T", "E", "B", "en", "s", "DRAFT", null, CATEGORY, List.of(TAG_A), series, 1, 1));
    }
}
