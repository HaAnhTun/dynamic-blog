package com.blog.search.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.ClientAddress;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.search.config.SearchProperties;
import com.blog.search.config.SearchProperties.Engine;
import com.blog.search.dto.SearchResponse;
import com.blog.search.meili.MeiliException;
import java.util.Arrays;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * {@code GET /api/v1/search}: validates parameters, applies the shared ceiling {@link RateLimiter#SEARCH}, then asks the
 * configured engine ({@code app.search.engine}).
 *
 * With Meilisearch: a failing engine ({@link MeiliException}: connection lost, over 800 ms, 5xx, missing index, wrong key)
 * gets the Postgres result with {@code degraded: true}, counted and logged at most once a minute ({@link SearchMetrics});
 * never silent. Bad parameters are still 400 before any engine call, and "no results" is never degraded. A post page
 * beyond the Meilisearch ceiling is served by Postgres, not degraded. The {@code engine} of the answer is the engine
 * that answered.
 *
 * No transaction here: the provider opens its own read-only transaction, so an external engine (Meilisearch) is called
 * while holding no DB connection. {@code q} is never logged anywhere, not even in error messages.
 */
@Service
@RequiredArgsConstructor
public class SearchService {

    /** Rows per group for {@code type=all}, and for one type (except posts: by {@code size}); also the ceiling. */
    private static final int GROUP_LIMIT_ALL = 5;

    private static final int GROUP_LIMIT_TYPE = 10;
    /** Page size of {@code type=post}: the default is in the controller (10), the ceiling is here. */
    private static final int MAX_POST_PAGE_SIZE = 50;

    private static final String ALL = "all";

    private final SearchProperties properties;
    private final RateLimiter rateLimiter;
    private final PostgresSearchProvider postgres;
    private final MeiliSearchProvider meilisearch;
    private final SearchMetrics metrics;

    /** A search over every language. */
    public SearchResponse search(
            String q,
            String type,
            Integer limit,
            int page,
            int size,
            String category,
            List<String> tag,
            String series,
            ClientAddress client) {
        return search(q, type, limit, page, size, category, tag, series, null, client);
    }

    /**
     * @param type     {@code all} or one of {@link SearchType}
     * @param limit    null means the default: 5 for {@code all}, 10 for one type; clamped to 1-10
     * @param language an enabled language code (validated by the caller) or null for every language; it narrows the
     *                 posts, and topics, series and authors to those with a published post in it
     * @param category filter (also {@code tag}, {@code series}) only accepted when {@code type=post}
     * @param client   where the request comes from (ClientAddressResolver); counted per address before the shared ceiling
     * @throws ApiException 400 {@code VALIDATION_ERROR} when {@code q} is longer than 200 code points after sanitizing,
     *                      {@code type} is unknown, a filter is given without {@code type=post}, or there are more than 5
     *                      distinct tags; 429 {@code RATE_LIMITED} when this client address or the shared ceiling is exceeded
     */
    public SearchResponse search(
            String q,
            String type,
            Integer limit,
            int page,
            int size,
            String category,
            List<String> tag,
            String series,
            String language,
            ClientAddress client) {
        String text = SearchLimits.query(q);
        SearchType scope = scope(type);
        List<String> tags = SearchLimits.tagFilters(tag);
        String categorySlug = SearchLimits.slugFilter(category);
        String seriesSlug = SearchLimits.slugFilter(series);
        boolean filtered = categorySlug != null || seriesSlug != null || !tags.isEmpty();
        if (filtered && scope != SearchType.POST) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.BAD_REQUEST,
                    "category, tag and series filters need type=post");
        }
        // Nothing to search for: costs no turn of the shared ceiling, touches neither the DB nor an engine.
        if (text.isEmpty() && !filtered) {
            return new SearchResponse(text, properties.engine(), false, List.of());
        }
        // This client address first: a caller over its own quota is refused before it spends a turn of the shared
        // ceiling,
        // so a few callers cannot use up the ceiling alone.
        rateLimiter.check(RateLimiter.SEARCH_CLIENT, client.key());
        rateLimiter.check(RateLimiter.SEARCH, RateLimiter.SEARCH_GLOBAL_KEY);

        int perGroup = Math.clamp(
                limit == null ? (scope == null ? GROUP_LIMIT_ALL : GROUP_LIMIT_TYPE) : limit, 1, GROUP_LIMIT_TYPE);
        SearchRequest request = new SearchRequest(
                text,
                scope,
                perGroup,
                SearchLimits.clampPage(page),
                SearchLimits.clampSize(size, MAX_POST_PAGE_SIZE),
                categorySlug,
                tags,
                seriesSlug,
                language);
        return answer(text, request);
    }

    /** Where the engine is chosen from {@code app.search.engine}, and the only place that falls back to Postgres. */
    private SearchResponse answer(String text, SearchRequest request) {
        if (properties.engine() == Engine.POSTGRES) {
            return new SearchResponse(text, Engine.POSTGRES, false, postgres.search(request));
        }
        if (MeiliSearchProvider.beyondHitCap(request)) {
            metrics.deepPageFallback();
            return new SearchResponse(text, Engine.POSTGRES, false, postgres.search(request));
        }
        try {
            return new SearchResponse(text, Engine.MEILISEARCH, false, meilisearch.search(request));
        } catch (MeiliException e) {
            metrics.degraded(e);
            return new SearchResponse(text, Engine.POSTGRES, true, postgres.search(request));
        }
    }

    /** null means every type. The error message does not echo the submitted value. */
    private static SearchType scope(String type) {
        if (type == null || type.isEmpty() || ALL.equals(type)) {
            return null;
        }
        return Arrays.stream(SearchType.values())
                .filter(candidate -> candidate.value().equals(type))
                .findFirst()
                .orElseThrow(() -> new ApiException(
                        ErrorCode.VALIDATION_ERROR,
                        HttpStatus.BAD_REQUEST,
                        "type must be one of all, post, topic, series, case-study, author, page"));
    }
}
