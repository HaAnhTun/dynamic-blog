package com.blog.comment.dto;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/**
 * Body for creating, replying to and editing a comment. Content only: the author is always the token owner, the
 * post comes from the path, and unknown fields (userId, status...) are ignored.
 *
 * {@code @Size(max = 10000)} only rejects an oversized body early, counted in UTF-16 units; the real rule is 2-2000
 * characters after sanitizing (CommentContent), counted in code points.
 */
public record CommentRequest(@NotNull @Size(max = 10000) String content) {}
