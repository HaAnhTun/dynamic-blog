package com.blog.media.dto;

import java.util.UUID;

/**
 * An image in a public DTO (post cover, gallery photo). No bytes and no admin-only fields
 * (original file name, uploader).
 *
 * @param fileName      {@code <uuid>.jpg|png}; the frontend builds the image path from this field only
 * @param altText       image description for screen readers; null when not entered
 * @param dominantColor {@code #rrggbb}, a placeholder background while the image loads; null for a fully transparent image
 */
public record MediaResponse(UUID id, String fileName, int width, int height, String altText, String dominantColor) {}
