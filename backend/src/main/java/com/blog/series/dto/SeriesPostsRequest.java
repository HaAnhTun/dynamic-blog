package com.blog.series.dto;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;

/**
 * The whole membership of a series, in reading order: the i-th post gets position i. An empty list detaches every post.
 * Ids must not repeat (the service returns 400), because a post cannot stand in two positions.
 */
public record SeriesPostsRequest(@NotNull @Size(max = 100) List<@NotNull UUID> postIds) {}
