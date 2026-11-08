package com.blog.sitecontent.controller;

import com.blog.common.response.ApiResponse;
import com.blog.sitecontent.dto.SiteContentPublicResponse;
import com.blog.sitecontent.service.SiteContentService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The owner's site content for the public pages. No authentication, and no caching header: Next caches the answer.
 * Only payloads leave here: no id, timestamp or user.
 */
@RestController
@RequestMapping("/api/v1/site-content")
@RequiredArgsConstructor
public class SiteContentController {

    private final SiteContentService siteContentService;

    /** A missing locale means the default locale; an unknown or disabled one is 400 {@code VALIDATION_ERROR}. */
    @GetMapping
    public ApiResponse<SiteContentPublicResponse> get(@RequestParam(name = "locale", required = false) String locale) {
        return ApiResponse.of(siteContentService.publicContent(locale));
    }
}
