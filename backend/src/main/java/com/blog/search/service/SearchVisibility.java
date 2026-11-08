package com.blog.search.service;

import com.blog.post.dto.PostSummaryResponse;
import com.blog.post.entity.Post;
import com.blog.post.repository.PostRepository;
import com.blog.post.service.PostService;
import com.blog.search.repository.SearchCatalogRepository;
import com.blog.search.repository.SearchCatalogRepository.AuthorRow;
import com.blog.search.repository.SearchCatalogRepository.SeriesRow;
import com.blog.search.repository.SearchCatalogRepository.TopicRow;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Re-validates Meilisearch results on Postgres (fail closed): Postgres is the source of truth, Meilisearch never decides
 * what may be shown. One batch query per type present in the DB, in a read-only transaction opened AFTER Meilisearch has
 * answered (a separate bean, so the provider calls it through the proxy and not on itself). An id missing from the
 * result is a stale result: the provider drops it.
 */
@Component
@RequiredArgsConstructor
public class SearchVisibility {

    private final PostRepository postRepository;
    private final PostService postService;
    private final SearchCatalogRepository catalog;

    /** Ids to re-validate, by type. */
    public record Ids(Set<UUID> posts, Set<UUID> categories, Set<UUID> tags, Set<UUID> series, Set<UUID> authors) {}

    /**
     * What can still be shown, by id. A post comes with its current Markdown, so the provider can check that the index
     * snippet still matches the content.
     */
    public record Visible(
            Map<UUID, VisiblePost> posts,
            Map<UUID, TopicRow> categories,
            Map<UUID, TopicRow> tags,
            Map<UUID, SeriesRow> series,
            Map<UUID, AuthorRow> authors) {}

    public record VisiblePost(PostSummaryResponse summary, String content) {}

    /**
     * Posts: published and the author ACTIVE; topics, series: still have a published post; authors: ACTIVE and have a
     * published post. With a {@code language} a topic, series or author must have a published post in it, and its name is
     * localized; a post in another language is the provider's to drop (the index is not trusted for it either).
     */
    @Transactional(readOnly = true)
    public Visible check(Ids ids, String language) {
        Map<UUID, VisiblePost> posts = new HashMap<>();
        if (!ids.posts().isEmpty()) {
            List<Post> entities = postRepository.findSearchableByIdIn(ids.posts());
            List<PostSummaryResponse> summaries = postService.toSummaries(entities);
            for (int i = 0; i < entities.size(); i++) {
                posts.put(
                        entities.get(i).getId(),
                        new VisiblePost(summaries.get(i), entities.get(i).getContent()));
            }
        }
        return new Visible(
                posts,
                byId(catalog.categoriesWithPublishedPosts(ids.categories(), language), TopicRow::id),
                byId(catalog.tagsWithPublishedPosts(ids.tags(), language), TopicRow::id),
                byId(catalog.seriesWithPublishedParts(ids.series(), language), SeriesRow::id),
                byId(catalog.activeAuthorsWithPublishedPosts(ids.authors(), language), AuthorRow::id));
    }

    private static <T> Map<UUID, T> byId(List<T> rows, Function<T, UUID> id) {
        return rows.stream().collect(Collectors.toMap(id, Function.identity()));
    }
}
