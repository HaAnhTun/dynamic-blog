package com.blog.search.dto;

import com.blog.search.config.SearchProperties.Engine;
import java.util.List;

/**
 * Response of {@code GET /api/v1/search}, inside {@code {"data": ...}}.
 *
 * @param query    the sanitized {@code q}
 * @param engine   the engine that answered
 * @param degraded true if and only if the configured engine failed and the result comes from Postgres
 * @param groups   only groups that have results, in a fixed order: posts, topics, series, case studies, authors, pages
 */
public record SearchResponse(String query, Engine engine, boolean degraded, List<SearchGroup> groups) {}
