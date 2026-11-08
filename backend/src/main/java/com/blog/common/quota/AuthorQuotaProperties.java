package com.blog.common.quota;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.util.unit.DataSize;

/**
 * What an AUTHOR may write, bound from {@code app.author-quota.*} (application.yml, each key has an environment variable). An
 * AUTHOR is the least trusted writer: the account may belong to a guest, and everything it creates is stored in the one shared
 * database and read whole by public pages. An ADMIN is exempt from every limit here. A non-positive number stops the
 * application from starting, like the other limits: 0 would block every write and nobody would know why. A key left empty (a bare
 * {@code AUTHOR_MAX_TAGS=} line in a .env file outside Docker Compose) has its default, like a key that is not set; the numbers are
 * {@code Integer} for that reason: an empty value converts to null, which a primitive cannot take.
 *
 * <p>The counts that a person does at human speed (tags per post, posts per day, images per post) and the sizes that
 * bound storage live here; the burst limits (writes, taxonomy creation and uploads in a time window) are
 * {@code app.rate-limit.post-write}, {@code taxonomy-create} and {@code media-upload}.
 *
 * @param maxTagsPerPost       tags on one post; more is 400 {@code VALIDATION_ERROR}
 * @param maxPostsPerDay       posts created in the last 24 hours, imports included; more is 429 {@code AUTHOR_QUOTA_EXCEEDED}
 * @param maxBodyImagesPerPost images in the body of one post; more is 422 {@code AUTHOR_QUOTA_EXCEEDED}
 * @param maxTags              tags in the whole catalog, above which an AUTHOR cannot create another one (422)
 * @param maxCategories        categories in the whole catalog, above which an AUTHOR cannot create another one (422)
 * @param mediaPerAuthor       stored image bytes (covers and body images) of one AUTHOR; over it is 422 {@code MEDIA_QUOTA_EXCEEDED}
 * @param mediaAllAuthorsPercent the share of {@code app.media.max-total-size} that all AUTHORS together may use (1 to 100); an
 *                             ADMIN's images are not counted in it and are not refused by it
 * @param maxSlugHistoryPerPost old addresses (slugs) that the post of an AUTHOR keeps working after renames; the oldest are
 *                             dropped, so renaming again and again cannot reserve addresses for good. An ADMIN's own posts keep all
 */
@ConfigurationProperties("app.author-quota")
public record AuthorQuotaProperties(
        @DefaultValue("10") Integer maxTagsPerPost,
        @DefaultValue("30") Integer maxPostsPerDay,
        @DefaultValue("30") Integer maxBodyImagesPerPost,
        @DefaultValue("1000") Integer maxTags,
        @DefaultValue("100") Integer maxCategories,
        @DefaultValue("100MB") DataSize mediaPerAuthor,
        @DefaultValue("50") Integer mediaAllAuthorsPercent,
        @DefaultValue("5") Integer maxSlugHistoryPerPost) {

    public AuthorQuotaProperties {
        positive("max-tags-per-post", maxTagsPerPost);
        positive("max-posts-per-day", maxPostsPerDay);
        positive("max-body-images-per-post", maxBodyImagesPerPost);
        positive("max-tags", maxTags);
        positive("max-categories", maxCategories);
        positive("max-slug-history-per-post", maxSlugHistoryPerPost);
        if (mediaPerAuthor == null || mediaPerAuthor.toBytes() <= 0) {
            throw invalid("media-per-author", mediaPerAuthor);
        }
        if (mediaAllAuthorsPercent < 1 || mediaAllAuthorsPercent > 100) {
            throw invalid("media-all-authors-percent", mediaAllAuthorsPercent + " (must be 1 to 100)");
        }
    }

    private static void positive(String name, int value) {
        if (value <= 0) {
            throw invalid(name, value);
        }
    }

    private static IllegalArgumentException invalid(String name, Object value) {
        return new IllegalArgumentException("app.author-quota." + name + " is invalid: " + value);
    }
}
