package com.blog.media.dto;

/**
 * Image storage of the site against the quota, for the size bar on the admin gallery page.
 *
 * @param usedBytes total bytes of all stored images (covers, gallery, post body): exactly the number the quota compares when accepting a new image
 * @param maxBytes  the configured quota ({@code app.media.max-total-size}, environment variable MEDIA_MAX_TOTAL_SIZE)
 * @param count     number of stored images
 */
public record MediaUsageResponse(long usedBytes, long maxBytes, long count) {}
