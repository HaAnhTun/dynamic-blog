package com.blog.category.dto;

/**
 * Result of one category merge.
 *
 * @param target the target category, as the admin list returns it
 * @param moved  number of posts (any status) moved from the source category
 */
public record CategoryMergeResponse(CategoryResponse target, long moved) {}
