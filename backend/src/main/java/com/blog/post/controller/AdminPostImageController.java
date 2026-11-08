package com.blog.post.controller;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.response.ApiResponse;
import com.blog.media.dto.MediaResponse;
import com.blog.post.service.PostImageService;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.MediaType;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * Images inside the post body. The same rule as every route that names a post
 * ({@link AdminPostController#CAN_MANAGE}): ADMIN for every post, AUTHOR for its own; a post that does not exist is
 * 403 for an AUTHOR (ids cannot be probed) and 404 for an ADMIN.
 *
 * {@code file} is not required at the binding layer, like the cover: a missing part makes MediaService return 400
 * AFTER the permission check, so someone with no permission on the post gets 403 whatever they send. {@code consumes}
 * turns a request that is not multipart into 415.
 */
@RestController
@RequestMapping("/api/v1/admin/posts/{id}/images")
@RequiredArgsConstructor
public class AdminPostImageController {

    private final PostImageService postImageService;

    /**
     * Uploads an image for the post body; returns the image (200, like the cover). The editor inserts
     * {@code /media/<fileName>} itself.
     */
    @PostMapping(consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    @PreAuthorize(AdminPostController.CAN_MANAGE)
    public ApiResponse<MediaResponse> upload(
            @PathVariable UUID id,
            @RequestParam(name = "file", required = false) MultipartFile file,
            @RequestParam(name = "altText", required = false) String altText) {
        return ApiResponse.of(postImageService.upload(id, file, altText, AuthenticatedUser.requireUserId()));
    }

    /** The images in the post's body, newest first. */
    @GetMapping
    @PreAuthorize(AdminPostController.CAN_MANAGE)
    public ApiResponse<List<MediaResponse>> list(@PathVariable UUID id) {
        return ApiResponse.of(postImageService.list(id));
    }

    /** Deletes one image from the post body; 200 with the remaining images (admin-api cannot read a 204). */
    @DeleteMapping("/{mediaId}")
    @PreAuthorize(AdminPostController.CAN_MANAGE)
    public ApiResponse<List<MediaResponse>> delete(@PathVariable UUID id, @PathVariable UUID mediaId) {
        return ApiResponse.of(postImageService.delete(id, mediaId));
    }
}
