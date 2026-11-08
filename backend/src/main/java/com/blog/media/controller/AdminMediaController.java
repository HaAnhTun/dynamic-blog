package com.blog.media.controller;

import com.blog.common.response.ApiResponse;
import com.blog.media.dto.MediaUsageResponse;
import com.blog.media.service.MediaService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Images of the site as seen from admin. ADMIN only, enforced by the URL rule {@code /api/v1/admin/media/**} in
 * SecurityConfig, like the gallery: the size is site-wide, there is no "my image" for an AUTHOR to view.
 *
 * There is no standalone image-upload route here (see MediaService): an image is only created together with its owner.
 */
@RestController
@RequestMapping("/api/v1/admin/media")
@RequiredArgsConstructor
public class AdminMediaController {

    private final MediaService mediaService;

    /** Used size, quota and image count; see MediaUsageResponse. */
    @GetMapping("/usage")
    public ApiResponse<MediaUsageResponse> usage() {
        return ApiResponse.of(mediaService.usage());
    }
}
