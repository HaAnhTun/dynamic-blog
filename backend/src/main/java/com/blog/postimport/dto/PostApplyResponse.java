package com.blog.postimport.dto;

import java.util.List;

/**
 * The outcome of an apply: one entry per uploaded file in upload order. {@code importId} is null when nothing was written
 * (every file was unchanged or skipped).
 */
public record PostApplyResponse(
        Long importId, List<PostAppliedFile> files, int created, int updated, int unchanged, int skipped) {}
