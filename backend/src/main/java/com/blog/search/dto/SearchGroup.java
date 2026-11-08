package com.blog.search.dto;

import com.blog.search.service.SearchType;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * A group of results of the same type. {@code total} is the number of matching results, not the number of rows returned.
 *
 * @param page       only when {@code type=post}: the page being returned (from 0)
 * @param totalPages only when {@code type=post}
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SearchGroup(SearchType type, long total, Integer page, Integer totalPages, List<SearchItem> items) {

    public SearchGroup(SearchType type, long total, List<SearchItem> items) {
        this(type, total, null, null, items);
    }
}
