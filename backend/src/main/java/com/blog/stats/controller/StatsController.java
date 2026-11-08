package com.blog.stats.controller;

import com.blog.common.response.ApiResponse;
import com.blog.stats.dto.StatsResponse;
import com.blog.stats.service.StatsService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Public statistics of the site: the "Statistics" block, and the decision whether to show the gallery section. */
@RestController
@RequestMapping("/api/v1/stats")
@RequiredArgsConstructor
public class StatsController {

    private final StatsService statsService;

    @GetMapping
    public ApiResponse<StatsResponse> get() {
        return ApiResponse.of(statsService.get());
    }
}
