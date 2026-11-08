package com.blog.search.service;

import com.blog.search.config.SearchProperties.Engine;
import com.blog.search.dto.SearchGroup;
import java.util.List;

/** A search engine behind {@code GET /api/v1/search}. Public content only, following the Postgres visibility rules. */
public interface SearchProvider {

    Engine engine();

    /** The groups that have results, in the order of {@link SearchType}. The parameters were already validated by {@link SearchService}. */
    List<SearchGroup> search(SearchRequest request);
}
