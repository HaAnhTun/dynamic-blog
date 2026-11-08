package com.blog.series.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * A series in {@code GET /api/v1/series}. Every number counts only the PUBLISHED parts: that is what readers see, and a
 * series with no such part is not in the list.
 *
 * @param readingMinutes    total reading time of the parts, each counted exactly as that post records it
 * @param latestPublishedAt the most recent publish among the parts; never null (a series has at least one part)
 * @param parts             the parts in reading order
 */
public record SeriesSummaryResponse(
        UUID id,
        String title,
        String slug,
        String description,
        int postCount,
        int readingMinutes,
        Instant latestPublishedAt,
        List<SeriesPartRef> parts) {}
