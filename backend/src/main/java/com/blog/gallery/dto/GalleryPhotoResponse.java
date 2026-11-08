package com.blog.gallery.dto;

import com.blog.media.dto.MediaResponse;
import java.time.LocalDate;
import java.util.UUID;

/**
 * A photo in the public gallery. Nothing only the admin sees (original file name, size, order, visibility flag): the
 * public list contains only visible photos, in the arranged order.
 *
 * @param caption the caption; null when none was entered
 * @param takenOn date taken {@code yyyy-MM-dd}, no time zone; null when unknown
 */
public record GalleryPhotoResponse(UUID id, MediaResponse image, String caption, LocalDate takenOn) {}
