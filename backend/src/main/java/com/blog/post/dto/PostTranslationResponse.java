package com.blog.post.dto;

/**
 * A translation of a post, as listed in {@link PostResponse#translations()}. In a post response it is always a published
 * sibling (status {@code PUBLISHED}); only the admin translations endpoint lists the others, and only to someone allowed to see them.
 */
public record PostTranslationResponse(String language, String slug, String title, String status) {}
