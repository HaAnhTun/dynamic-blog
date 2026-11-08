package com.blog.analytics.dto;

import com.blog.post.entity.PostStatus;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

/**
 * View report ({@code GET /api/v1/admin/analytics}). Every number is a recorded view, not a visitor or a session. Days
 * follow {@code timeZone}.
 *
 * @param since    first day with per-day data within the caller's scope, regardless of the range; null when there is none
 * @param daily    every day of the range, a day without views is 0
 * @param topPosts up to 10 posts with the most views in the range, ties broken by title then id
 * @param sources  all six groups, in a fixed order
 */
public record AnalyticsResponse(
        LocalDate from,
        LocalDate to,
        String timeZone,
        LocalDate since,
        AnalyticsTotals totals,
        List<AnalyticsDay> daily,
        List<AnalyticsTopPost> topPosts,
        List<AnalyticsSource> sources) {

    /**
     * @param views        total within the range
     * @param allTimeViews all-time total of the posts in scope, any status, from each post's own counter
     *                     ({@code post_views}): includes views before {@code since}
     */
    public record AnalyticsTotals(long views, long allTimeViews) {}

    public record AnalyticsDay(LocalDate day, long views) {}

    public record AnalyticsTopPost(UUID id, String slug, String title, PostStatus status, long views) {}

    /** @param source value of {@code ViewSource}: direct, search, social, github, internal, other */
    public record AnalyticsSource(String source, long views) {}
}
