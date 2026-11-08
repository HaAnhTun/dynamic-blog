package com.blog.post.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * A full revision: the text of the post at that time.
 *
 * @param excerpt   null when the post had no excerpt at that time
 * @param createdAt when the revision was written, i.e. when a save (or a restore) replaced this state
 */
public record PostRevisionResponse(UUID id, String title, String excerpt, String content, Instant createdAt) {}
