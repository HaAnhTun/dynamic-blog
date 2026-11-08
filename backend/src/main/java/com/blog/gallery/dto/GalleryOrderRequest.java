package com.blog.gallery.dto;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.UUID;

/**
 * The new gallery order: must be an exact permutation of ALL photos (hidden ones included); the i-th photo gets order i.
 * A list missing any photo (a stale tab that has not seen a photo just uploaded in another tab) is rejected instead of
 * guessing a position for that photo.
 */
public record GalleryOrderRequest(@NotNull @Size(max = 2000) List<@NotNull UUID> photoIds) {}
