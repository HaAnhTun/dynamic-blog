package com.blog.post.dto;

import com.blog.category.dto.CategoryResponse;
import com.blog.media.dto.MediaResponse;
import com.blog.series.dto.SeriesRefResponse;
import com.blog.tag.dto.TagResponse;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Four components (cover, series, rank, view count) were appended at the END, after the older components which keep
 * their order, followed by {@code updatedAt}; nobody builds this record positionally except PostMapper.
 *
 * @param cover        cover image, or null when the post has none (the UI draws cover art instead)
 * @param series       the series the post belongs to, or null; "Part n/m" is read from its {@code partNumber/partCount}
 * @param featuredRank rank in "Featured posts" (1 is first), or null when not ranked
 * @param viewCount    counted views; an approximate number, not for anything important
 * @param updatedAt    last edit of the post, exactly the value of {@link PostResponse#updatedAt} (sitemap lastmod, the
 *                     admin's "recently edited"). Save, publish and unpublish change it; featuring, ranking, series
 *                     ordering, cover and a deleted tag do not, because those are editorial acts, not post edits
 * @param author       public author, appended at the end after {@code updatedAt}
 * @param language     the language of the post, one of the enabled locales
 * @param translations the published siblings of the same article ({@link PostTranslationResponse}), empty when there are none
 */
public record PostSummaryResponse(
        UUID id,
        String title,
        String slug,
        String excerpt,
        String status,
        CategoryResponse category,
        List<TagResponse> tags,
        boolean featured,
        int readingMinutes,
        Instant publishedAt,
        MediaResponse cover,
        SeriesRefResponse series,
        Integer featuredRank,
        long viewCount,
        Instant updatedAt,
        PostAuthorResponse author,
        String language,
        List<PostTranslationResponse> translations) {}
