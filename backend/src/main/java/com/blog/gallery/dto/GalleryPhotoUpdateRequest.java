package com.blog.gallery.dto;

import jakarta.validation.constraints.NotNull;
import java.time.LocalDate;

/**
 * Body of {@code PUT /api/v1/admin/gallery/{id}}: replaces everything. Null, a blank string or a missing key all clear
 * the old value, except {@code published}, which is required: without it, "replace everything" would have to guess
 * whether the photo is hidden or visible.
 *
 * No {@code @Size}: the caption (at most 1000) and alt text (at most 300) are checked in the service, trimmed and then
 * counted by character, the same rule those fields go through on multipart upload. A {@code @Size} here would count
 * UTF-16 units and count before trimming, so it would reject a caption that the upload path itself accepts (GalleryIT
 * pins this).
 *
 * @param altText image description for screen readers; written to the image (media table), not to the gallery photo
 * @param takenOn date taken {@code yyyy-MM-dd}
 */
public record GalleryPhotoUpdateRequest(
        String caption,
        String altText,
        LocalDate takenOn,
        @NotNull Boolean published) {}
