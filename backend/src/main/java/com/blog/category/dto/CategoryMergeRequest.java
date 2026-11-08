package com.blog.category.dto;

import jakarta.validation.constraints.NotNull;
import java.util.UUID;

/**
 * Body of {@code POST /api/v1/admin/categories/{id}/merge}: the category that receives every post of
 * category {@code {id}}.
 */
public record CategoryMergeRequest(@NotNull UUID targetId) {}
