package com.blog.gallery.dto;

import com.blog.media.dto.MediaResponse;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

/**
 * A gallery photo on the admin screen: the public part plus the part only the admin sees.
 *
 * @param sortOrder        smaller comes first; a new photo gets a number lower than every existing one, reordering writes 1..n
 * @param originalFilename file name on the uploader's machine, sanitized (basename only); null when absent
 * @param byteSize         size of the STORED image (after downscaling and re-encoding), not of the uploaded file
 * @param updatedAt        last edit of the photo (caption, alt text, taken-on date, visibility); reordering does not count
 */
public record GalleryPhotoAdminResponse(
        UUID id,
        MediaResponse image,
        String caption,
        LocalDate takenOn,
        boolean published,
        int sortOrder,
        String originalFilename,
        int byteSize,
        Instant createdAt,
        Instant updatedAt) {}
