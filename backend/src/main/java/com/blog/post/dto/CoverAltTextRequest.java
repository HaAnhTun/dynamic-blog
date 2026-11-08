package com.blog.post.dto;

/**
 * Body of {@code PUT /api/v1/admin/posts/{id}/cover}: replaces the whole cover description. Null, a blank string or a
 * missing key all clear the description.
 *
 * No {@code @Size}: the length is checked in {@code MediaService} (trimmed, then counted in characters, like the
 * VARCHAR(300) column), the very rule the altText of a multipart upload goes through. A {@code @Size(max = 300)} here
 * counts UTF-16 units and counts before trimming, so it would reject a description the upload path itself accepts
 * (PostCoverIT pins this).
 */
public record CoverAltTextRequest(String altText) {}
