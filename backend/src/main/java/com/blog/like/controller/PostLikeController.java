package com.blog.like.controller;

import com.blog.common.response.ApiResponse;
import com.blog.like.dto.LikeResponse;
import com.blog.like.service.PostLikeService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Likes of a post. GET is open to everyone (rule for GET {@code /api/v1/posts/**}); PUT and DELETE need login, any
 * role (per-method rules in SecurityConfig). No method accepts a body: the liking user is always the token owner.
 *
 * All three return 200 with {@code {liked, count}}, DELETE included: the like button shows exactly the state the
 * server returns.
 */
@RestController
@RequestMapping("/api/v1/posts/{slug}/like")
@RequiredArgsConstructor
public class PostLikeController {

    private final PostLikeService postLikeService;

    @GetMapping
    public ApiResponse<LikeResponse> get(@PathVariable String slug) {
        return ApiResponse.of(postLikeService.get(slug));
    }

    /** Like; idempotent. */
    @PutMapping
    public ApiResponse<LikeResponse> like(@PathVariable String slug) {
        return ApiResponse.of(postLikeService.like(slug));
    }

    /** Unlike; idempotent. */
    @DeleteMapping
    public ApiResponse<LikeResponse> unlike(@PathVariable String slug) {
        return ApiResponse.of(postLikeService.unlike(slug));
    }
}
