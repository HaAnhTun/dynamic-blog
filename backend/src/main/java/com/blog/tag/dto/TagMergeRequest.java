package com.blog.tag.dto;

import jakarta.validation.constraints.NotNull;
import java.util.UUID;

/** Body of {@code POST /api/v1/admin/tags/{id}/merge}: the tag that receives every post of tag {@code {id}}. */
public record TagMergeRequest(@NotNull UUID targetId) {}
