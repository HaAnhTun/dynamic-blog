package com.blog.post.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * A revision in a post's history list: no content, just enough to choose which one to view.
 *
 * @param createdAt when the revision was written, i.e. when a save (or a restore) replaced this state
 */
public record PostRevisionSummaryResponse(UUID id, String title, Instant createdAt) {}
