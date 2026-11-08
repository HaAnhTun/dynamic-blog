package com.blog.common.quota;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.support.AuthorQuotaTestProperties;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.util.unit.DataSize;

/** The defaults of the limits on an AUTHOR, and that a wrong value stops the application from starting. */
class AuthorQuotaPropertiesTest {

    @Test
    void the_defaults_are_conservative() {
        AuthorQuotaProperties defaults = AuthorQuotaTestProperties.defaults();

        assertThat(defaults.maxTagsPerPost()).isEqualTo(10);
        assertThat(defaults.maxPostsPerDay()).isEqualTo(30);
        assertThat(defaults.maxBodyImagesPerPost()).isEqualTo(30);
        assertThat(defaults.maxTags()).isEqualTo(1000);
        assertThat(defaults.maxCategories()).isEqualTo(100);
        assertThat(defaults.mediaPerAuthor()).isEqualTo(DataSize.ofMegabytes(100));
        assertThat(defaults.mediaAllAuthorsPercent()).isEqualTo(50);
        assertThat(defaults.maxSlugHistoryPerPost()).isEqualTo(5);
    }

    @Test
    void every_value_can_be_set_by_its_key() {
        AuthorQuotaProperties set = AuthorQuotaTestProperties.with(Map.of(
                "max-tags-per-post", "3",
                "max-posts-per-day", "4",
                "max-body-images-per-post", "5",
                "max-tags", "6",
                "max-categories", "7",
                "media-per-author", "8MB",
                "media-all-authors-percent", "9",
                "max-slug-history-per-post", "10"));

        assertThat(set).isEqualTo(new AuthorQuotaProperties(3, 4, 5, 6, 7, DataSize.ofMegabytes(8), 9, 10));
    }

    @Test
    void a_key_set_to_nothing_has_its_default_like_an_unset_one() {
        // A line such as AUTHOR_MAX_TAGS_PER_POST= in a .env file outside Docker Compose reaches the application as an
        // empty value.
        for (String key : new String[] {
            "max-tags-per-post",
            "max-posts-per-day",
            "max-body-images-per-post",
            "max-tags",
            "max-categories",
            "media-per-author",
            "media-all-authors-percent",
            "max-slug-history-per-post"
        }) {
            assertThat(AuthorQuotaTestProperties.with(Map.of(key, "")))
                    .as("%s=", key)
                    .isEqualTo(AuthorQuotaTestProperties.defaults());
        }
    }

    @Test
    void a_non_positive_number_or_a_percent_out_of_range_is_refused_with_the_key_in_the_message() {
        for (String[] invalid : new String[][] {
            {"max-tags-per-post", "0"},
            {"max-posts-per-day", "-1"},
            {"max-body-images-per-post", "0"},
            {"max-tags", "0"},
            {"max-categories", "0"},
            {"media-per-author", "0B"},
            {"media-all-authors-percent", "0"},
            {"media-all-authors-percent", "101"},
            {"max-slug-history-per-post", "0"}
        }) {
            assertThatThrownBy(() -> AuthorQuotaTestProperties.with(Map.of(invalid[0], invalid[1])))
                    .as("%s=%s", invalid[0], invalid[1])
                    .rootCause()
                    .hasMessageContaining("app.author-quota." + invalid[0]);
        }
    }
}
