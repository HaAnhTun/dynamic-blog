package com.blog.search.controller;

import com.blog.common.i18n.Languages;
import com.blog.common.ratelimit.ClientAddressResolver;
import com.blog.common.response.ApiResponse;
import com.blog.search.dto.SearchResponse;
import com.blog.search.service.SearchService;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Public search across every kind of published content: the quick-search panel and the Next {@code /search} page both
 * call this endpoint. Rules and limits are in {@link SearchService}; public (GET) in SecurityConfig.
 */
@RestController
@RequestMapping("/api/v1/search")
@RequiredArgsConstructor
public class SearchController {

    private final SearchService searchService;
    private final Languages languages;
    private final ClientAddressResolver clientAddresses;

    @GetMapping
    public ApiResponse<SearchResponse> search(
            @RequestParam(defaultValue = "") String q,
            @RequestParam(defaultValue = "all") String type,
            @RequestParam(required = false) Integer limit,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "10") int size,
            @RequestParam(required = false) String category,
            @RequestParam(required = false) List<String> tag,
            @RequestParam(required = false) String series,
            @RequestParam(required = false) String lang,
            HttpServletRequest http) {
        return ApiResponse.of(searchService.search(
                q,
                type,
                limit,
                page,
                size,
                category,
                tag,
                series,
                languages.optional(lang),
                clientAddresses.resolve(http)));
    }
}
