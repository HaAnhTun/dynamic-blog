package com.blog.comment.controller;

import com.blog.comment.dto.CommentAdminResponse;
import com.blog.comment.dto.CommentStatusRequest;
import com.blog.comment.entity.CommentStatus;
import com.blog.comment.service.CommentModerationService;
import com.blog.common.response.ApiResponse;
import com.blog.common.response.PageMeta;
import com.blog.common.response.PagedResponse;
import jakarta.validation.Valid;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Comment moderation. ADMIN only, enforced by the URL rule {@code /api/v1/admin/comments/**} in
 * SecurityConfig rather than {@code @PreAuthorize}: comments belong to readers, there is no "my comments" for an
 * AUTHOR to manage.
 */
@RestController
@RequestMapping("/api/v1/admin/comments")
@RequiredArgsConstructor
public class AdminCommentController {

    private final CommentModerationService moderationService;

    /**
     * Newest first. An empty {@code status} means every status; an unknown value is 400. {@code q} searches the
     * content, login and author name. {@code postId} limits the list to one post's comments; empty means all
     * posts, an id that is not a UUID is 400 (type conversion error), an id that matches no post gives an empty
     * page.
     */
    @GetMapping
    public PagedResponse<CommentAdminResponse> list(
            @RequestParam(required = false) CommentStatus status,
            @RequestParam(required = false) String q,
            @RequestParam(required = false) UUID postId,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        Page<CommentAdminResponse> result = moderationService.list(status, q, postId, page, size);
        return new PagedResponse<>(
                result.getContent(),
                new PageMeta(result.getNumber(), result.getSize(), result.getTotalElements(), result.getTotalPages()));
    }

    /** Hide or show again; repeating is a no-op. Deleted comment: 409. */
    @PatchMapping("/{id}/status")
    public ApiResponse<CommentAdminResponse> setStatus(
            @PathVariable UUID id, @Valid @RequestBody CommentStatusRequest request) {
        return ApiResponse.of(moderationService.setStatus(id, request.status()));
    }

    /** Soft delete; 204 with no body, repeating still returns 204. */
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID id) {
        moderationService.delete(id);
    }
}
