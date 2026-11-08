package com.blog.tag.dto;

/**
 * Result of one tag merge.
 *
 * @param target the target tag, as the admin list returns it
 * @param moved  number of posts (any status) that carried the source tag, including posts that already had the target
 *               tag
 */
public record TagMergeResponse(TagResponse target, long moved) {}
