package com.blog.post.dto;

import com.blog.category.dto.CategoryResponse;
import com.blog.media.dto.MediaResponse;
import com.blog.series.dto.SeriesRefResponse;
import com.blog.tag.dto.TagResponse;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * The components after {@code updatedAt} mean the same as in {@link PostSummaryResponse}, and were also appended at
 * the end. {@code language} and {@code translations} (published siblings of the same article, never the post itself, never
 * a draft) come last.
 */
public record PostResponse(
        UUID id,
        String title,
        String slug,
        String excerpt,
        String content,
        String status,
        CategoryResponse category,
        List<TagResponse> tags,
        boolean featured,
        int readingMinutes,
        Instant publishedAt,
        Instant createdAt,
        Instant updatedAt,
        MediaResponse cover,
        SeriesRefResponse series,
        Integer featuredRank,
        long viewCount,
        PostAuthorResponse author,
        String language,
        List<PostTranslationResponse> translations) {}
