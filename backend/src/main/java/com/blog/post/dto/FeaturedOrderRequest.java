package com.blog.post.dto;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;

/**
 * The whole "Featured posts" order: the i-th post in the list gets rank i and is made featured if it is not yet. A post
 * not in the list only loses its rank and keeps {@code featured}; an empty list clears every rank. Ids must not repeat
 * (the service returns 400), because one post cannot hold two ranks.
 */
public record FeaturedOrderRequest(@NotNull @Size(max = 50) List<@NotNull UUID> postIds) {}
