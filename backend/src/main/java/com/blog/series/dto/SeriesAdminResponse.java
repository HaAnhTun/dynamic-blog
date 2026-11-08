package com.blog.series.dto;

import com.blog.common.i18n.LocalizedText;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/** A series on the admin screen: all its posts, unpublished ones included, by position. */
public record SeriesAdminResponse(
        UUID id,
        String title,
        String slug,
        String description,
        Map<String, LocalizedText> translations,
        List<SeriesAdminPostResponse> posts,
        Instant createdAt,
        Instant updatedAt) {}
