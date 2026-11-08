package com.blog.gallery.controller;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.response.ApiResponse;
import com.blog.gallery.dto.GalleryOrderRequest;
import com.blog.gallery.dto.GalleryPhotoAdminResponse;
import com.blog.gallery.dto.GalleryPhotoUpdateRequest;
import com.blog.gallery.service.GalleryService;
import jakarta.validation.Valid;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * Gallery administration. ADMIN only, enforced by the URL rule {@code /api/v1/admin/gallery/**} in SecurityConfig and
 * not by {@code @PreAuthorize}: the gallery belongs to the site, there is no "my photo" for an AUTHOR to manage, like
 * series and users.
 */
@RestController
@RequestMapping("/api/v1/admin/gallery")
@RequiredArgsConstructor
public class AdminGalleryController {

    private final GalleryService galleryService;

    @GetMapping
    public ApiResponse<List<GalleryPhotoAdminResponse>> list() {
        return ApiResponse.of(galleryService.listAll());
    }

    /**
     * One photo per request: the UI uploads several photos one at a time and reports progress, so one broken photo does
     * not fail the whole batch, and each request stays under the Server Action body limit.
     *
     * {@code file} is not required at the binding layer: a missing part makes MediaService return 400 VALIDATION_ERROR,
     * like an empty file. {@code consumes} turns a non-multipart request into 415. A malformed {@code takenOn} is a 400
     * (type conversion error); an empty string (a blank date field in the form) means not sent.
     */
    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<GalleryPhotoAdminResponse> upload(
            @RequestParam(name = "file", required = false) MultipartFile file,
            @RequestParam(name = "caption", required = false) String caption,
            @RequestParam(name = "altText", required = false) String altText,
            @RequestParam(name = "takenOn", required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE)
                    LocalDate takenOn,
            @RequestParam(name = "published", required = false) Boolean published) {
        return ApiResponse.of(
                galleryService.upload(file, caption, altText, takenOn, published, AuthenticatedUser.requireUserId()));
    }

    /**
     * The new order of ALL photos. The literal path wins over {@code /{id}} when the handler is chosen, so "order" is
     * never read as the id of a photo.
     */
    @PutMapping("/order")
    public ApiResponse<List<GalleryPhotoAdminResponse>> reorder(@Valid @RequestBody GalleryOrderRequest request) {
        return ApiResponse.of(galleryService.reorder(request.photoIds()));
    }

    /** Replaces the whole caption, alt text, taken-on date and visibility flag. */
    @PutMapping("/{id}")
    public ApiResponse<GalleryPhotoAdminResponse> update(
            @PathVariable UUID id, @Valid @RequestBody GalleryPhotoUpdateRequest request) {
        return ApiResponse.of(galleryService.update(id, request));
    }

    /** Deletes a gallery photo together with its image and bytes; the image URL becomes 404. */
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID id) {
        galleryService.delete(id);
    }
}
