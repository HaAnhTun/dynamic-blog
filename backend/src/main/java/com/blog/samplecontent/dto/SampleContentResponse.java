package com.blog.samplecontent.dto;

/**
 * What one "load sample content" call did: the items it created, and how many it left alone because they already existed
 * (posts are matched by slug, series, categories and tags by name, ignoring letter case).
 */
public record SampleContentResponse(int posts, int series, int categories, int tags, int skipped) {}
