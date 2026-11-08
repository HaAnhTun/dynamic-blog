package com.blog.series.dto;

import java.util.UUID;

/**
 * A post in a series on the admin screen, any status.
 *
 * @param position the stored position, which may have gaps (a post moved to another series); the next order save renumbers
 */
public record SeriesAdminPostResponse(UUID id, String title, String slug, String status, int position) {}
