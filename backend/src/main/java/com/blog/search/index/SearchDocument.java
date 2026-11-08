package com.blog.search.index;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * A document of the search index. Public fields only; a field that does not apply to this type is null and is not sent.
 * Built by {@link SearchDocuments}, where the text is cleaned and {@code contentHash} is computed.
 *
 * @param id             {@code <type>-<uuid or slug>}, only {@code [A-Za-z0-9_-]}
 * @param type           {@link DocType#value()}
 * @param sourceId       uuid (content in the DB) or slug (static content)
 * @param title          display name: post title, category name, tag name, series name, author name, page title
 * @param excerpt        post excerpt, category/series/page description, case study summary
 * @param body           lowercase text of the post body (Markdown syntax removed), case study body
 * @param tags           tag names, for searching; {@code tagSlugs} are slugs, for filtering
 * @param category       category name, for searching; {@code categorySlug} for filtering. {@code series} likewise
 * @param publishedAt    epoch milliseconds, to sort filtered lists that have no query
 * @param language       the language of a post (a string); on a category, tag, series or author the sorted distinct
 *                       languages of their published posts (a list); absent on static content. A filter
 *                       {@code language = "xx"} matches both shapes
 * @param contentHash    SHA-256 of every other field: reconciliation compares this field, not {@code updatedAt}
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SearchDocument(
        String id,
        String type,
        String sourceId,
        String slug,
        String href,
        String title,
        String excerpt,
        String body,
        List<String> tags,
        List<String> tagSlugs,
        String category,
        String categorySlug,
        String series,
        String seriesSlug,
        String author,
        String authorSlug,
        Long publishedAt,
        Integer readingMinutes,
        Object language,
        String contentHash) {}
