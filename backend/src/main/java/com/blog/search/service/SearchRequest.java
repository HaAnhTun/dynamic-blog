package com.blog.search.service;

import java.util.List;

/**
 * One search that has been validated and clamped ({@link SearchService}): the provider validates nothing again.
 *
 * @param text     the sanitized {@code q}; empty only when there is a filter ({@code type=post}): then it is a newest-first list
 * @param type     one type, or null for every type ({@code type=all})
 * @param limit    maximum rows per group, except the post group of {@code type=post} (by {@code page}/{@code size})
 * @param category slug with whitespace stripped, null means no filter; {@code series} likewise. Only present when {@code type=post}
 * @param tags     distinct tag slugs, empty means no filter; a post must carry every tag
 * @param language an enabled language code, null means every language
 */
public record SearchRequest(
        String text,
        SearchType type,
        int limit,
        int page,
        int size,
        String category,
        List<String> tags,
        String series,
        String language) {

    public SearchRequest {
        tags = List.copyOf(tags);
    }

    /** A search over every language. */
    public SearchRequest(
            String text,
            SearchType type,
            int limit,
            int page,
            int size,
            String category,
            List<String> tags,
            String series) {
        this(text, type, limit, page, size, category, tags, series, null);
    }

    public boolean wants(SearchType candidate) {
        return type == null || type == candidate;
    }
}
