package com.blog.analytics.controller;

import com.blog.analytics.dto.AnalyticsResponse;
import com.blog.analytics.service.AnalyticsService;
import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.response.ApiResponse;
import java.time.LocalDate;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * View statistics for the admin area. The {@code /api/v1/admin/analytics/**} URL rule lets only ADMIN and AUTHOR in; the
 * scope is decided here like AdminPostController.listAll: ADMIN sees the whole site, AUTHOR only their own posts,
 * filtered in the SQL statement.
 */
@RestController
@RequestMapping("/api/v1/admin/analytics")
@RequiredArgsConstructor
public class AnalyticsController {

    private final AnalyticsService analyticsService;

    /** {@code from}, {@code to}: YYYY-MM-DD, optional; a malformed value is 400 VALIDATION_ERROR (GlobalExceptionHandler). */
    @GetMapping
    public ApiResponse<AnalyticsResponse> get(
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
            @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to) {
        UUID authorScope = AuthenticatedUser.hasRole("ADMIN") ? null : AuthenticatedUser.requireUserId();
        return ApiResponse.of(analyticsService.report(from, to, authorScope));
    }
}
