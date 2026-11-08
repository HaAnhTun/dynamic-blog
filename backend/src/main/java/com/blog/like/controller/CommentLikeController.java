package com.blog.like.controller;

import com.blog.common.response.ApiResponse;
import com.blog.like.dto.LikeResponse;
import com.blog.like.service.CommentLikeService;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Likes of a comment. PUT and DELETE need login, any role (per-method rules in SecurityConfig); there is no GET:
 * the numbers come with the comment ({@code likeCount}, {@code likedByMe}). No method accepts a body: the liking
 * user is always the token owner.
 *
 * Both return 200 with {@code {liked, count}}, DELETE included, like post likes.
 */
@RestController
@RequestMapping("/api/v1/comments/{id}/like")
@RequiredArgsConstructor
public class CommentLikeController {

    private final CommentLikeService commentLikeService;

    /** Like; idempotent. */
    @PutMapping
    public ApiResponse<LikeResponse> like(@PathVariable UUID id) {
        return ApiResponse.of(commentLikeService.like(id));
    }

    /** Unlike; idempotent. */
    @DeleteMapping
    public ApiResponse<LikeResponse> unlike(@PathVariable UUID id) {
        return ApiResponse.of(commentLikeService.unlike(id));
    }
}
