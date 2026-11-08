package com.blog.post.dto;

/**
 * Answer of {@code GET /api/v1/posts/{slug}/redirect}: where an old slug lives now. Next receives it after
 * {@code GET /api/v1/posts/{slug}} returned 404, then redirects permanently to {@code /posts/<slug>}.
 *
 * @param slug the CURRENT slug of the published post that once held the requested slug; never equal to the requested
 *             slug
 */
public record PostRedirectResponse(String slug) {}
