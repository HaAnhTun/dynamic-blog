package com.blog.gallery.controller;

import com.blog.common.response.PageMeta;
import com.blog.common.response.PagedResponse;
import com.blog.gallery.dto.GalleryPhotoResponse;
import com.blog.gallery.service.GalleryService;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Public gallery: only visible photos, in the order the site owner arranged. 24 per page is the 3-column grid of the /gallery page. */
@RestController
@RequestMapping("/api/v1/gallery")
@RequiredArgsConstructor
public class GalleryController {

    private final GalleryService galleryService;

    @GetMapping
    public PagedResponse<GalleryPhotoResponse> list(
            @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "24") int size) {
        Page<GalleryPhotoResponse> result = galleryService.listPublished(page, size);
        return new PagedResponse<>(
                result.getContent(),
                new PageMeta(result.getNumber(), result.getSize(), result.getTotalElements(), result.getTotalPages()));
    }
}
