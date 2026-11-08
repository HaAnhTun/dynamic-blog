package com.blog.series.dto;

import com.blog.post.dto.PostSummaryResponse;
import java.util.List;
import java.util.UUID;

/**
 * {@code GET /api/v1/series/{slug}}: the published parts in reading order. Each part is a post summary like in every
 * list, so it already carries "Part n/m" ({@code series.partNumber/partCount}), the cover image and the view count.
 */
public record SeriesDetailResponse(
        UUID id, String title, String slug, String description, List<PostSummaryResponse> posts) {}
