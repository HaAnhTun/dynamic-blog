package com.blog.media.service;

import java.time.LocalDate;

/**
 * An image that went through the pipeline, ready to be stored.
 *
 * @param bytes         the re-encoded image (no EXIF, GPS, ICC or any other metadata of the original file)
 * @param contentType   {@code image/jpeg} or {@code image/png}, matching {@code bytes}
 * @param width         width after EXIF rotation and downscaling
 * @param height        height after EXIF rotation and downscaling
 * @param sha256        lowercase hex SHA-256 of exactly {@code bytes}; also the ETag when serving
 * @param dominantColor lowercase {@code #rrggbb}, the opacity-weighted average color; null for a fully transparent image
 * @param takenOn       date taken from the EXIF DateTimeOriginal of the original file, null when absent
 */
public record ProcessedImage(
        byte[] bytes,
        String contentType,
        int width,
        int height,
        String sha256,
        String dominantColor,
        LocalDate takenOn) {}
