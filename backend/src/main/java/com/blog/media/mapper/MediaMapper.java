package com.blog.media.mapper;

import com.blog.media.dto.MediaResponse;
import com.blog.media.entity.Media;

public final class MediaMapper {

    private MediaMapper() {}

    /** Null in, null out: a post without a cover has {@code cover: null}, not an empty object. */
    public static MediaResponse toResponse(Media media) {
        if (media == null) {
            return null;
        }
        return new MediaResponse(
                media.getId(),
                media.fileName(),
                media.getWidth(),
                media.getHeight(),
                media.getAltText(),
                media.getDominantColor());
    }
}
