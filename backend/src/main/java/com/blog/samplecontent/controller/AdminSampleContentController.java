package com.blog.samplecontent.controller;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.response.ApiResponse;
import com.blog.samplecontent.dto.SampleContentResponse;
import com.blog.samplecontent.service.SampleContentService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Loads the packaged sample posts, series, category and tags. ADMIN only, enforced by the URL rule
 * {@code /api/v1/admin/sample-content/**} in SecurityConfig. Idempotent: a second call creates nothing.
 */
@RestController
@RequestMapping("/api/v1/admin/sample-content")
@RequiredArgsConstructor
public class AdminSampleContentController {

    private final SampleContentService sampleContentService;

    @PostMapping
    public ApiResponse<SampleContentResponse> load() {
        return ApiResponse.of(sampleContentService.load(AuthenticatedUser.requireUserId()));
    }
}
