package com.blog.search.service;

import com.blog.common.security.SeedAdmin;
import com.blog.search.config.SearchProperties;
import com.blog.search.config.SearchProperties.Engine;
import com.blog.search.dto.ItemMeta.AuthorMeta;
import com.blog.search.dto.ItemMeta.SeriesMeta;
import com.blog.search.dto.ItemMeta.TopicMeta;
import com.blog.search.dto.SearchGroup;
import com.blog.search.dto.SearchItem;
import com.blog.search.dto.Segment;
import com.blog.search.index.DocType;
import com.blog.search.index.MarkdownText;
import com.blog.search.index.SearchText;
import com.blog.search.meili.MeiliException;
import com.blog.search.meili.MeiliFilter;
import com.blog.search.meili.MeiliHttpClient;
import com.blog.search.meili.MeiliKeys;
import com.blog.search.meili.MeiliSettings;
import com.blog.search.repository.SearchCatalogRepository.AuthorRow;
import com.blog.search.repository.SearchCatalogRepository.SeriesRow;
import com.blog.search.repository.SearchCatalogRepository.TopicRow;
import com.blog.search.service.SearchVisibility.VisiblePost;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;

/**
 * Search on Meilisearch, with the same contract and the same row shape as {@link PostgresSearchProvider}: one
 * {@code multi-search} for every requested group, then every result is re-validated on Postgres ({@link SearchVisibility},
 * fail closed) and rows are built from the current DB data, not from the index. A failing engine throws
 * {@link MeiliException}: {@link SearchService} returns the Postgres result, degraded.
 *
 * Semantics: every word must match ({@code matchingStrategy: all}, AND like Postgres); the last word matches by prefix;
 * typo tolerance on by default. Highlighting uses two sentinel characters, turned into {@link Segment}s here; the
 * description of a post is a snippet around the match in the post body when the excerpt does not match. Index text that
 * is older than the DB (a name, excerpt or body just edited) is not used: that row is highlighted again on the current
 * text, and the stale snippet is dropped.
 */
@Component
@RequiredArgsConstructor
public class MeiliSearchProvider implements SearchProvider {

    /** Fetch a few extra results for each non-paginated group, to make up for stale results dropped on re-validation. */
    static final int STALE_SLACK = 3;

    static final int CROP_WORDS = 30;

    private static final boolean PREFIX = true;
    private static final List<String> RETRIEVE = List.of("type", "sourceId");
    private static final List<String> HIGHLIGHT = List.of("title", "excerpt", "body");
    private static final Pattern NEGATION = Pattern.compile("(^|\\s)-+");
    private static final Pattern WHITESPACE = Pattern.compile("\\s+");

    private final MeiliHttpClient client;
    private final MeiliKeys keys;
    private final SearchProperties properties;
    private final SearchVisibility visibility;
    private final StaticSearchContent staticContent;
    private final SearchMetrics metrics;

    @Override
    public Engine engine() {
        return Engine.MEILISEARCH;
    }

    /** A post page beyond the {@code maxTotalHits} ceiling: Meilisearch cannot return it, Postgres does. */
    static boolean beyondHitCap(SearchRequest request) {
        return request.type() == SearchType.POST
                && (long) (request.page() + 1) * request.size() > MeiliSettings.MAX_TOTAL_HITS;
    }

    @Override
    public List<SearchGroup> search(SearchRequest request) {
        // A slug filter of the wrong shape, or a query with nothing to search for: like Postgres, nothing matches and
        // the engine is not called.
        if (!filtersAreSlugs(request) || nothingToMatch(request)) {
            return List.of();
        }
        List<SearchType> types =
                Arrays.stream(SearchType.values()).filter(request::wants).toList();
        List<Map<String, Object>> queries =
                types.stream().map(type -> query(request, type)).toList();
        keys.ensureProvisioned();
        JsonNode results;
        try {
            results = client.multiSearch(queries);
        } catch (MeiliException e) {
            if (e.code() == MeiliException.Code.INVALID_API_KEY) {
                keys.invalidate();
            }
            throw e;
        }
        List<Answer> answers = new ArrayList<>();
        for (int i = 0; i < types.size(); i++) {
            answers.add(answer(types.get(i), results.get(i)));
        }

        // Meilisearch has answered: only now open the transaction (one batch query per type).
        SearchVisibility.Visible visible = visibility.check(ids(answers), request.language());
        List<SearchGroup> groups = new ArrayList<>();
        int dropped = 0;
        for (Answer answer : answers) {
            int cap = request.type() == SearchType.POST ? request.size() : request.limit();
            List<SearchItem> items = new ArrayList<>();
            int stale = 0;
            for (Hit hit : answer.hits()) {
                SearchItem item = answer.type() == groupOf(hit.type())
                        ? item(hit, request.text(), request.language(), visible)
                        : null;
                if (item == null) {
                    stale++;
                } else if (items.size() < cap) {
                    items.add(item);
                }
            }
            dropped += stale;
            long total = Math.max(answer.totalHits() - stale, items.size());
            if (total <= 0) {
                continue;
            }
            groups.add(
                    request.type() == SearchType.POST
                            ? new SearchGroup(
                                    SearchType.POST,
                                    total,
                                    request.page(),
                                    (int) ((total + request.size() - 1) / request.size()),
                                    items)
                            : new SearchGroup(answer.type(), total, items));
        }
        metrics.staleHitsDropped(dropped);
        return groups;
    }

    // ------------------------------------------------------------------------------------------------ query

    private Map<String, Object> query(SearchRequest request, SearchType type) {
        boolean paged = request.type() == SearchType.POST;
        Map<String, Object> query = new LinkedHashMap<>();
        query.put("indexUid", properties.meili().indexName());
        query.put("q", queryText(request.text()));
        query.put("filter", filter(request, type));
        query.put("page", paged ? request.page() + 1 : 1);
        query.put("hitsPerPage", paged ? request.size() : request.limit() + STALE_SLACK);
        query.put("matchingStrategy", "all");
        query.put("attributesToRetrieve", RETRIEVE);
        query.put("attributesToHighlight", HIGHLIGHT);
        query.put("attributesToCrop", List.of("body"));
        query.put("cropLength", CROP_WORDS);
        query.put("cropMarker", SearchText.CROP_MARKER);
        query.put("highlightPreTag", String.valueOf(SearchText.HIGHLIGHT_PRE));
        query.put("highlightPostTag", String.valueOf(SearchText.HIGHLIGHT_POST));
        if (request.text().isEmpty()) {
            // No text (filters only): newest first, like /search today.
            query.put("sort", List.of("publishedAt:desc"));
        }
        return query;
    }

    /**
     * The query sent to Meilisearch: drops double quotes (phrases) and a leading hyphen (exclusion), two syntaxes that
     * Postgres treats as punctuation. Keeping them would make Meilisearch return fewer results than Postgres for the same input.
     */
    static String queryText(String text) {
        return NEGATION.matcher(text.replace('"', ' ')).replaceAll("$1");
    }

    /**
     * There is a {@code q} but no letter or digit is left after {@link #queryText} ({@code !!}, {@code --}, {@code +}):
     * Meilisearch has no word to search for, so it runs an empty search and returns every document, while Postgres (an empty
     * {@code plainto_tsquery}) returns nothing. An empty {@code q} (filters only) is not this case.
     */
    static boolean nothingToMatch(SearchRequest request) {
        return !request.text().isEmpty()
                && queryText(request.text()).codePoints().noneMatch(Character::isLetterOrDigit);
    }

    /** Array form: every element is ANDed. Only code constants and checked slugs (MeiliFilter throws for anything else). */
    static List<String> filter(SearchRequest request, SearchType type) {
        List<String> filter = new ArrayList<>();
        switch (type) {
            case POST -> {
                filter.add(MeiliFilter.equalTo("type", DocType.POST.value()));
                if (request.category() != null) {
                    filter.add(MeiliFilter.equalTo("categorySlug", request.category()));
                }
                if (request.series() != null) {
                    filter.add(MeiliFilter.equalTo("seriesSlug", request.series()));
                }
                request.tags().forEach(tag -> filter.add(MeiliFilter.equalTo("tagSlugs", tag)));
            }
            case TOPIC -> filter.add(MeiliFilter.in("type", List.of(DocType.CATEGORY.value(), DocType.TAG.value())));
            case SERIES -> filter.add(MeiliFilter.equalTo("type", DocType.SERIES.value()));
            case CASE_STUDY -> filter.add(MeiliFilter.equalTo("type", DocType.CASE_STUDY.value()));
            case AUTHOR -> filter.add(MeiliFilter.equalTo("type", DocType.AUTHOR.value()));
            case PAGE -> filter.add(MeiliFilter.equalTo("type", DocType.PAGE.value()));
        }
        if (request.language() != null) {
            filter.add(MeiliFilter.languageOrMissing(request.language()));
        }
        return filter;
    }

    private static boolean filtersAreSlugs(SearchRequest request) {
        return SearchLimits.isSlugOrAbsent(request.category())
                && SearchLimits.isSlugOrAbsent(request.series())
                && request.tags().stream().allMatch(SearchLimits::isSlug);
    }

    // ------------------------------------------------------------------------------------------------ answer

    /** @param type null when the document carries an unknown type (an index from another version): treated as a stale result */
    private record Hit(DocType type, String sourceId, UUID uuid, String title, String excerpt, String body) {}

    private record Answer(SearchType type, long totalHits, List<Hit> hits) {}

    private static Answer answer(SearchType type, JsonNode result) {
        JsonNode hits = result.path("hits");
        JsonNode total = result.path("totalHits");
        if (!hits.isArray() || !total.isIntegralNumber()) {
            throw new MeiliException(MeiliException.Code.INVALID_RESPONSE);
        }
        List<Hit> parsed = new ArrayList<>();
        for (JsonNode hit : hits) {
            DocType docType = DocType.of(hit.path("type").asString("")).orElse(null);
            String sourceId = hit.path("sourceId").asString("");
            JsonNode formatted = hit.path("_formatted");
            parsed.add(new Hit(
                    docType,
                    sourceId,
                    docType != null && docType.fromDatabase() ? uuid(sourceId) : null,
                    text(formatted.path("title")),
                    text(formatted.path("excerpt")),
                    text(formatted.path("body"))));
        }
        return new Answer(type, total.asLong(), parsed);
    }

    private static SearchVisibility.Ids ids(List<Answer> answers) {
        Map<DocType, Set<UUID>> ids = new LinkedHashMap<>();
        for (DocType type : DocType.values()) {
            ids.put(type, new HashSet<>());
        }
        answers.forEach(answer -> answer.hits().forEach(hit -> {
            if (hit.uuid() != null) {
                ids.get(hit.type()).add(hit.uuid());
            }
        }));
        return new SearchVisibility.Ids(
                ids.get(DocType.POST),
                ids.get(DocType.CATEGORY),
                ids.get(DocType.TAG),
                ids.get(DocType.SERIES),
                ids.get(DocType.AUTHOR));
    }

    private static SearchType groupOf(DocType type) {
        if (type == null) {
            return null;
        }
        return switch (type) {
            case POST -> SearchType.POST;
            case CATEGORY, TAG -> SearchType.TOPIC;
            case SERIES -> SearchType.SERIES;
            case AUTHOR -> SearchType.AUTHOR;
            case CASE_STUDY -> SearchType.CASE_STUDY;
            case PAGE -> SearchType.PAGE;
        };
    }

    /** The row of one result, built from current data; null when it can no longer be shown (a stale result). */
    private SearchItem item(Hit hit, String query, String language, SearchVisibility.Visible visible) {
        return switch (hit.type()) {
            case POST -> {
                VisiblePost post = visible.posts().get(hit.uuid());
                yield post == null || !inLanguage(post, language)
                        ? null
                        : SearchItems.post(
                                post.summary(),
                                titleSegments(hit.title(), post.summary().title(), query),
                                postDescription(hit, post, query));
            }
            case CATEGORY -> {
                TopicRow row = visible.categories().get(hit.uuid());
                yield row == null
                        ? null
                        : new SearchItem(
                                SearchItems.categoryId(row.slug()),
                                titleSegments(hit.title(), row.name(), query),
                                description(hit.excerpt(), row.description(), query),
                                SearchItems.categoryHref(row.slug()),
                                new TopicMeta("category", row.posts()),
                                null);
            }
            case TAG -> {
                TopicRow row = visible.tags().get(hit.uuid());
                yield row == null
                        ? null
                        : new SearchItem(
                                SearchItems.tagId(row.slug()),
                                titleSegments(hit.title(), row.name(), query),
                                null,
                                SearchItems.tagHref(row.slug()),
                                new TopicMeta("tag", row.posts()),
                                null);
            }
            case SERIES -> {
                SeriesRow row = visible.series().get(hit.uuid());
                yield row == null
                        ? null
                        : new SearchItem(
                                SearchItems.seriesId(row.slug()),
                                titleSegments(hit.title(), row.title(), query),
                                description(hit.excerpt(), row.description(), query),
                                SearchItems.seriesHref(row.slug()),
                                new SeriesMeta(row.parts()),
                                null);
            }
            case AUTHOR -> {
                AuthorRow row = visible.authors().get(hit.uuid());
                if (row == null) {
                    yield null;
                }
                boolean owner = SeedAdmin.ID.equals(row.id());
                String href = owner ? staticContent.owner().href() : SearchItems.authorHref(row.publicSlug());
                yield new SearchItem(
                        SearchItems.authorId(href),
                        titleSegments(hit.title(), owner ? staticContent.owner().name() : row.displayName(), query),
                        null,
                        href,
                        new AuthorMeta(row.avatarUrl()),
                        null);
            }
            case CASE_STUDY ->
                staticContent.caseStudies().stream()
                        .filter(study -> study.slug().equals(hit.sourceId()))
                        .findFirst()
                        .map(study -> new SearchItem(
                                SearchItems.caseStudyId(study.slug()),
                                titleSegments(hit.title(), study.title(), query),
                                caseStudyDescription(hit, study, query),
                                study.href(),
                                null,
                                null))
                        .orElse(null);
            case PAGE ->
                staticContent.pages().stream()
                        .filter(page -> page.slug().equals(hit.sourceId()))
                        .findFirst()
                        .map(page -> new SearchItem(
                                SearchItems.pageId(page.href()),
                                titleSegments(hit.title(), page.title(), query),
                                description(hit.excerpt(), page.description(), query),
                                page.href(),
                                null,
                                null))
                        .orElse(null);
        };
    }

    /** A post of another language is stale for this search: the index said otherwise, the database decides. */
    private static boolean inLanguage(VisiblePost post, String language) {
        return language == null || language.equals(post.summary().language());
    }

    /**
     * The excerpt when it matches; otherwise a snippet around the match in the post body; otherwise the excerpt; a post
     * with no excerpt gets the start of its body.
     */
    private static List<Segment> postDescription(Hit hit, VisiblePost post, String query) {
        String excerpt =
                post.summary().excerpt() == null ? "" : post.summary().excerpt().strip();
        List<Segment> summary = description(hit.excerpt(), excerpt, query);
        if (SearchText.hasMatch(summary)) {
            return summary;
        }
        List<Segment> crop = crop(hit.body(), () -> SearchText.stripPrivateUse(MarkdownText.plain(post.content())));
        if (SearchText.hasMatch(crop) || summary == null) {
            return crop;
        }
        return summary;
    }

    private static List<Segment> caseStudyDescription(Hit hit, StaticSearchContent.CaseStudy study, String query) {
        List<Segment> summary = description(hit.excerpt(), study.summary(), query);
        if (SearchText.hasMatch(summary)) {
            return summary;
        }
        List<Segment> crop = crop(hit.body(), () -> SearchText.stripPrivateUse(study.body()));
        if (SearchText.hasMatch(crop) || summary == null) {
            return crop;
        }
        return summary;
    }

    /** Title: the Meilisearch highlighted segments when its text equals the current text, otherwise highlighted again on the current text. */
    private static List<Segment> titleSegments(String formatted, String current, String query) {
        if (formatted != null) {
            List<Segment> segments = SearchText.segments(formatted);
            if (SearchText.joined(segments).equals(current)) {
                return segments;
            }
        }
        return Highlighter.segments(current, query, PREFIX);
    }

    /** Like {@link #titleSegments}; null when there is no description. */
    private static List<Segment> description(String formatted, String current, String query) {
        return current == null || current.isEmpty() ? null : titleSegments(formatted, current, query);
    }

    /**
     * The Meilisearch snippet, only when its text (without the crop markers) is still inside the current content: a stale
     * index must not show a sentence that was edited out of the post. Whitespace (including newlines) collapses to one space.
     */
    private static List<Segment> crop(String formatted, Supplier<String> currentPlain) {
        if (formatted == null || formatted.isBlank()) {
            return null;
        }
        List<Segment> segments = SearchText.segments(formatted);
        String core = SearchText.joined(segments).strip();
        while (core.startsWith(SearchText.CROP_MARKER)) {
            core = core.substring(SearchText.CROP_MARKER.length()).strip();
        }
        while (core.endsWith(SearchText.CROP_MARKER)) {
            core = core.substring(0, core.length() - SearchText.CROP_MARKER.length())
                    .strip();
        }
        if (core.isEmpty() || !currentPlain.get().contains(core)) {
            return null;
        }
        return segments.stream()
                .map(segment -> new Segment(WHITESPACE.matcher(segment.text()).replaceAll(" "), segment.match()))
                .toList();
    }

    private static String text(JsonNode node) {
        return node.isString() ? node.asString() : null;
    }

    private static UUID uuid(String value) {
        try {
            UUID parsed = UUID.fromString(value);
            return parsed.toString().equals(value) ? parsed : null;
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
