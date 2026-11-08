package com.blog.stats.dto;

/**
 * Public figures of the site ({@code GET /api/v1/stats}). Each number only counts what a reader can see.
 *
 * @param publishedPosts number of published posts
 * @param totalViews     total views of the published posts
 * @param seriesCount    number of series with at least one published part
 * @param galleryPhotos  number of visible gallery photos; the UI uses it to hide an empty gallery section without loading the gallery
 */
public record StatsResponse(long publishedPosts, long totalViews, long seriesCount, long galleryPhotos) {}
