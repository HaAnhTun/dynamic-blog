package com.blog.search.service;

import com.blog.common.security.SeedAdmin;
import com.blog.post.dto.PostSummaryResponse;
import com.blog.post.service.PostService;
import com.blog.search.config.SearchProperties.Engine;
import com.blog.search.dto.ItemMeta;
import com.blog.search.dto.ItemMeta.AuthorMeta;
import com.blog.search.dto.ItemMeta.SeriesMeta;
import com.blog.search.dto.ItemMeta.TopicMeta;
import com.blog.search.dto.SearchGroup;
import com.blog.search.dto.SearchItem;
import com.blog.search.repository.SearchCatalogRepository;
import com.blog.search.repository.SearchCatalogRepository.AuthorRow;
import com.blog.search.repository.SearchCatalogRepository.SeriesRow;
import com.blog.search.repository.SearchCatalogRepository.TopicRow;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Search on Postgres for every type, with the same semantics as the earlier quick-search panel ({@code
 * frontend/lib/search-suggest.ts}): posts through the existing full-text search ({@link PostService#search}, whole-word
 * match); topics, series, authors, case studies and pages are filtered in place, matching word prefixes after folding
 * diacritics. A title match ranks before a description-only match, then more posts first, keeping the source order on ties.
 */
@Component
@RequiredArgsConstructor
public class PostgresSearchProvider implements SearchProvider {

    private static final boolean PREFIX = true;

    private static final Comparator<Candidate> RANK = Comparator.comparing(Candidate::titleMatch)
            .reversed()
            .thenComparing(Comparator.comparingInt(Candidate::weight).reversed());

    private final PostService postService;
    private final SearchCatalogRepository catalog;
    private final StaticSearchContent staticContent;

    @Override
    public Engine engine() {
        return Engine.POSTGRES;
    }

    @Override
    @Transactional(readOnly = true)
    public List<SearchGroup> search(SearchRequest request) {
        List<SearchGroup> groups = new ArrayList<>();
        String query = request.text();
        for (SearchType type : SearchType.values()) {
            if (!request.wants(type)) {
                continue;
            }
            SearchGroup group = switch (type) {
                case POST -> posts(request);
                case TOPIC -> group(type, topics(query, request.language()), request.limit());
                case SERIES -> group(type, series(query, request.language()), request.limit());
                case CASE_STUDY -> group(type, caseStudies(query), request.limit());
                case AUTHOR -> group(type, authors(query, request.language()), request.limit());
                case PAGE -> group(type, pages(query), request.limit());
            };
            if (group != null) {
                groups.add(group);
            }
        }
        return groups;
    }

    /**
     * A post tab with the page and filters of {@code /posts/search}; on "All" it is the first page of size {@code limit}.
     * The group is present when there is a matching post, even when the requested page is past the last one:
     * {@code /search} needs the total to return 404.
     */
    private SearchGroup posts(SearchRequest request) {
        boolean tab = request.type() == SearchType.POST;
        Page<PostSummaryResponse> page = tab
                ? postService.search(
                        request.text(),
                        request.category(),
                        request.tags(),
                        request.series(),
                        request.page(),
                        request.size(),
                        request.language())
                : postService.search(request.text(), null, null, null, 0, request.limit(), request.language());
        if (page.getTotalElements() == 0) {
            return null;
        }
        List<SearchItem> items = page.getContent().stream()
                .map(post -> postItem(post, request.text()))
                .toList();
        long total = page.getTotalElements();
        return tab
                ? new SearchGroup(SearchType.POST, total, page.getNumber(), page.getTotalPages(), items)
                : new SearchGroup(SearchType.POST, total, items);
    }

    private static SearchItem postItem(PostSummaryResponse post, String query) {
        String excerpt = post.excerpt() == null ? "" : post.excerpt().strip();
        return SearchItems.post(
                post,
                Highlighter.segments(post.title(), query, false),
                excerpt.isEmpty() ? null : Highlighter.segments(excerpt, query, false));
    }

    private List<Candidate> topics(String query, String language) {
        List<Candidate> candidates = new ArrayList<>();
        for (TopicRow category : catalog.categoriesWithPublishedPosts(language)) {
            add(
                    candidates,
                    candidate(
                            query,
                            SearchItems.categoryId(category.slug()),
                            SearchItems.categoryHref(category.slug()),
                            category.name(),
                            category.description(),
                            new TopicMeta("category", category.posts()),
                            category.posts()));
        }
        for (TopicRow tag : catalog.tagsWithPublishedPosts(language)) {
            add(
                    candidates,
                    candidate(
                            query,
                            SearchItems.tagId(tag.slug()),
                            SearchItems.tagHref(tag.slug()),
                            tag.name(),
                            null,
                            new TopicMeta("tag", tag.posts()),
                            tag.posts()));
        }
        return candidates;
    }

    private List<Candidate> series(String query, String language) {
        List<Candidate> candidates = new ArrayList<>();
        for (SeriesRow series : catalog.seriesWithPublishedParts(language)) {
            add(
                    candidates,
                    candidate(
                            query,
                            SearchItems.seriesId(series.slug()),
                            SearchItems.seriesHref(series.slug()),
                            series.title(),
                            series.description(),
                            new SeriesMeta(series.parts()),
                            0));
        }
        return candidates;
    }

    /** The site owner goes to {@code /about} with the site's name; anyone else goes to the profile {@code /u/<slug>}. */
    private List<Candidate> authors(String query, String language) {
        List<Candidate> candidates = new ArrayList<>();
        StaticSearchContent.Owner owner = staticContent.owner();
        for (AuthorRow author : catalog.activeAuthorsWithPublishedPosts(language)) {
            boolean isOwner = SeedAdmin.ID.equals(author.id());
            String href = isOwner ? owner.href() : SearchItems.authorHref(author.publicSlug());
            add(
                    candidates,
                    candidate(
                            query,
                            SearchItems.authorId(href),
                            href,
                            isOwner ? owner.name() : author.displayName(),
                            null,
                            new AuthorMeta(author.avatarUrl()),
                            0));
        }
        return candidates;
    }

    private List<Candidate> caseStudies(String query) {
        List<Candidate> candidates = new ArrayList<>();
        for (StaticSearchContent.CaseStudy study : staticContent.caseStudies()) {
            add(
                    candidates,
                    candidate(
                            query,
                            SearchItems.caseStudyId(study.slug()),
                            study.href(),
                            study.title(),
                            study.summary(),
                            null,
                            0));
        }
        return candidates;
    }

    private List<Candidate> pages(String query) {
        List<Candidate> candidates = new ArrayList<>();
        for (StaticSearchContent.Page page : staticContent.pages()) {
            add(
                    candidates,
                    candidate(
                            query,
                            SearchItems.pageId(page.href()),
                            page.href(),
                            page.title(),
                            page.description(),
                            null,
                            0));
        }
        return candidates;
    }

    /** Prefix match on the title, or on the title plus description (every query word, AND); null when it does not match. */
    private static Candidate candidate(
            String query, String id, String href, String title, String description, ItemMeta meta, int weight) {
        boolean titleMatch = Highlighter.matchesQuery(title, query, PREFIX);
        boolean hasDescription = description != null && !description.isEmpty();
        if (!titleMatch && !(hasDescription && Highlighter.matchesQuery(title + " " + description, query, PREFIX))) {
            return null;
        }
        SearchItem item = new SearchItem(
                id,
                Highlighter.segments(title, query, PREFIX),
                hasDescription ? Highlighter.segments(description, query, PREFIX) : null,
                href,
                meta,
                null);
        return new Candidate(item, titleMatch, weight);
    }

    private static void add(List<Candidate> candidates, Candidate candidate) {
        if (candidate != null) {
            candidates.add(candidate);
        }
    }

    private static SearchGroup group(SearchType type, List<Candidate> candidates, int limit) {
        if (candidates.isEmpty()) {
            return null;
        }
        // sorted() of an ordered stream is a stable sort: on equal rank the source order is kept.
        List<SearchItem> items = candidates.stream()
                .sorted(RANK)
                .limit(limit)
                .map(Candidate::item)
                .toList();
        return new SearchGroup(type, candidates.size(), items);
    }

    private record Candidate(SearchItem item, boolean titleMatch, int weight) {}
}
