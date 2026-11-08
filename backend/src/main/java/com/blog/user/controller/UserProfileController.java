package com.blog.user.controller;

import com.blog.common.response.ApiResponse;
import com.blog.user.dto.UserProfileResponse;
import com.blog.user.service.UserProfileService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The public profile, no login needed: the {@code GET /api/v1/users/*} rule of SecurityConfig. That person's posts are
 * {@code GET /api/v1/posts?author={slug}}.
 */
@RestController
@RequestMapping("/api/v1/users")
@RequiredArgsConstructor
public class UserProfileController {

    private final UserProfileService userProfileService;

    @GetMapping("/{slug}")
    public ApiResponse<UserProfileResponse> get(@PathVariable String slug) {
        return ApiResponse.of(userProfileService.get(slug));
    }
}
