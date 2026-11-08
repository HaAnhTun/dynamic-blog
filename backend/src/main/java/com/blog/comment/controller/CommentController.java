package com.blog.comment.controller;

import com.blog.comment.dto.CommentPage;
import com.blog.comment.dto.CommentRequest;
import com.blog.comment.dto.CommentResponse;
import com.blog.comment.service.CommentService;
import com.blog.common.response.ApiResponse;
import jakarta.validation.Valid;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
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

/**
 * Public comments and the caller's own comments.
 *
 * Reading is open to everyone (rule for GET {@code /api/v1/posts/**}); every write needs login, with any role
 * including USER (per-method rules in SecurityConfig). Who may edit or delete which comment, and suspended users,
 * is CommentService's job: URL rules cannot read the DB. Admin moderation lives at
 * {@code /api/v1/admin/comments}, not here.
 */
@RestController
@RequestMapping("/api/v1")
@RequiredArgsConstructor
public class CommentController {

    private final CommentService commentService;

    /** One page of root comments with their replies; {@code mine} is true only when the request carries the author's token. */
    @GetMapping("/posts/{slug}/comments")
    public ApiResponse<CommentPage> list(
            @PathVariable String slug,
            @RequestParam(required = false) String after,
            @RequestParam(defaultValue = "10") int size) {
        return ApiResponse.of(commentService.list(slug, after, size));
    }

    @PostMapping("/posts/{slug}/comments")
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<CommentResponse> create(@PathVariable String slug, @Valid @RequestBody CommentRequest request) {
        return ApiResponse.of(commentService.create(slug, request));
    }

    @PostMapping("/comments/{id}/replies")
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<CommentResponse> reply(@PathVariable UUID id, @Valid @RequestBody CommentRequest request) {
        return ApiResponse.of(commentService.reply(id, request));
    }

    @PutMapping("/comments/{id}")
    public ApiResponse<CommentResponse> edit(@PathVariable UUID id, @Valid @RequestBody CommentRequest request) {
        return ApiResponse.of(commentService.edit(id, request));
    }

    /** Soft delete; 204 with no body, 404 the second time. */
    @DeleteMapping("/comments/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID id) {
        commentService.delete(id);
    }
}
