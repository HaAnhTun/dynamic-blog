package com.blog.comment.dto;

import com.blog.comment.entity.CommentStatus;
import jakarta.validation.constraints.NotNull;

/**
 * Body of {@code PATCH /api/v1/admin/comments/{id}/status}: {@code HIDDEN} hides, {@code VISIBLE} shows again.
 * Deletion has its own route ({@code DELETE}), so {@code DELETED} here is 400 (CommentModerationService). An
 * unknown value or wrong letter case is 400 as soon as the body is read; unknown fields are ignored.
 */
public record CommentStatusRequest(@NotNull CommentStatus status) {}
