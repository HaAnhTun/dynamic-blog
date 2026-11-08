package com.blog.series.controller;

import com.blog.common.i18n.Languages;
import com.blog.common.response.ApiResponse;
import com.blog.series.dto.SeriesDetailResponse;
import com.blog.series.dto.SeriesSummaryResponse;
import com.blog.series.service.SeriesService;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Public series: only series that have a published part, and only those parts. */
@RestController
@RequestMapping("/api/v1/series")
@RequiredArgsConstructor
public class SeriesController {

    private final SeriesService seriesService;
    private final Languages languages;

    @GetMapping
    public ApiResponse<List<SeriesSummaryResponse>> list(@RequestParam(required = false) String lang) {
        return ApiResponse.of(seriesService.listPublished(languages.optional(lang)));
    }

    @GetMapping("/{slug}")
    public ApiResponse<SeriesDetailResponse> getBySlug(
            @PathVariable String slug, @RequestParam(required = false) String lang) {
        return ApiResponse.of(seriesService.getPublishedBySlug(slug, languages.optional(lang)));
    }
}
