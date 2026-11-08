package com.blog.search.meili;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Settings of the search index, a single constant: applied before the first batch of documents and the task is awaited,
 * because changing tokenization reindexes every document. Whatever changes here requires rebuilding the index.
 *
 * Text fields ({@code tags}, {@code category}, {@code series}) are names for searching; filtering runs on separate slug
 * fields ({@code tagSlugs}, ...), because a field that carried both names and slugs would let a slug filter also match a
 * different name that equals the slug.
 */
public final class MeiliSettings {

    /** Ceiling of results Meilisearch counts and paginates; deeper pages are served by Postgres. */
    public static final int MAX_TOTAL_HITS = 1000;

    /** In priority order: a title match ranks above a body match. */
    public static final List<String> SEARCHABLE = List.of("title", "tags", "category", "series", "excerpt", "body");

    public static final List<String> FILTERABLE = List.of("type", "tagSlugs", "categorySlug", "seriesSlug", "language");
    public static final List<String> SORTABLE = List.of("publishedAt");
    /** Every field of {@code SearchDocument} (all public); a stray field accidentally added to a document is never returned either. */
    public static final List<String> DISPLAYED = List.of(
            "id",
            "type",
            "sourceId",
            "slug",
            "href",
            "title",
            "excerpt",
            "body",
            "tags",
            "tagSlugs",
            "category",
            "categorySlug",
            "series",
            "seriesSlug",
            "author",
            "authorSlug",
            "publishedAt",
            "readingMinutes",
            "language",
            "contentHash");

    public static final Map<String, Object> SETTINGS = settings();

    private MeiliSettings() {}

    private static Map<String, Object> settings() {
        Map<String, Object> settings = new LinkedHashMap<>();
        settings.put("searchableAttributes", SEARCHABLE);
        settings.put("filterableAttributes", FILTERABLE);
        settings.put("sortableAttributes", SORTABLE);
        settings.put("displayedAttributes", DISPLAYED);
        // C++ and C# become a single word. "." and "_" stay boundaries: "loads" finds json.loads, snake_case is two
        // words.
        settings.put("nonSeparatorTokens", List.of("+", "#"));
        settings.put("typoTolerance", Map.of("disableOnNumbers", true));
        // Below the 800 ms wait of the backend: on timeout Meilisearch returns what it has computed, without an error.
        settings.put("searchCutoffMs", 500);
        settings.put("pagination", Map.of("maxTotalHits", MAX_TOTAL_HITS));
        return Collections.unmodifiableMap(settings);
    }
}
