package com.blog.search.controller;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.response.ApiResponse;
import com.blog.search.dto.ReindexReport;
import com.blog.search.dto.SearchStatusResponse;
import com.blog.search.service.SearchReindexService;
import com.blog.search.service.SearchStatusService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Search maintenance. ADMIN only, decided by the URL rule {@code /api/v1/admin/search/**} in SecurityConfig; AUTHOR
 * never gets here.
 */
@RestController
@RequestMapping("/api/v1/admin/search")
@RequiredArgsConstructor
public class AdminSearchController {

    private final SearchReindexService reindexService;
    private final SearchStatusService statusService;

    /** Defaults to a dry run: a real rebuild must be requested explicitly with {@code dryRun=false}. */
    @PostMapping("/reindex")
    public ApiResponse<ReindexReport> reindex(@RequestParam(defaultValue = "true") boolean dryRun) {
        return ApiResponse.of(reindexService.reindex(AuthenticatedUser.requireUserId(), dryRun));
    }

    @GetMapping("/status")
    public ApiResponse<SearchStatusResponse> status() {
        return ApiResponse.of(statusService.status());
    }
}
