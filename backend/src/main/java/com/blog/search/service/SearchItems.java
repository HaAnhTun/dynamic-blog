package com.blog.search.service;

import com.blog.post.dto.PostAuthorResponse;
import com.blog.post.dto.PostSummaryResponse;
import com.blog.search.dto.ItemMeta;
import com.blog.search.dto.ItemMeta.PostMeta;
import com.blog.search.dto.SearchItem;
import com.blog.search.dto.Segment;
import com.blog.tag.dto.TagResponse;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Id, path and post row of a search result, in one place for both engines (and for the index documents): the two
 * providers cannot return two different shapes for the same content. The id of a row is the {@code <type>:<slug or path>}
 * of the contract, not the Meilisearch document id.
 */
public final class SearchItems {

    private SearchItems() {}

    public static String postHref(String slug) {
        return "/posts/" + pathSegment(slug);
    }

    public static String categoryHref(String slug) {
        return "/categories/" + pathSegment(slug);
    }

    public static String tagHref(String slug) {
        return "/tags/" + pathSegment(slug);
    }

    public static String seriesHref(String slug) {
        return "/series/" + pathSegment(slug);
    }

    public static String authorHref(String publicSlug) {
        return "/u/" + publicSlug;
    }

    static String categoryId(String slug) {
        return "category:" + slug;
    }

    static String tagId(String slug) {
        return "tag:" + slug;
    }

    static String seriesId(String slug) {
        return "series:" + slug;
    }

    static String authorId(String href) {
        return "author:" + href;
    }

    static String caseStudyId(String slug) {
        return "case-study:" + slug;
    }

    static String pageId(String href) {
        return "page:" + href;
    }

    /**
     * Post row: the meta is the category, the author (only when not the site owner), the date, the reading time and at
     * most 2 tags; {@code post} is the public summary for {@code /search}.
     */
    static SearchItem post(PostSummaryResponse post, List<Segment> title, List<Segment> description) {
        PostAuthorResponse author = post.author();
        ItemMeta meta = new PostMeta(
                post.category() == null ? null : post.category().name(),
                author != null && !author.siteOwner() ? author.displayName() : null,
                post.publishedAt(),
                post.readingMinutes() > 0 ? post.readingMinutes() : null,
                post.tags().isEmpty()
                        ? null
                        : post.tags().stream().limit(2).map(TagResponse::name).toList());
        return new SearchItem("post:" + post.slug(), title, description, postHref(post.slug()), meta, post);
    }

    /** Like {@code encodeURIComponent} for a slug ({@code [a-z0-9-]}, so in practice unchanged). */
    private static String pathSegment(String slug) {
        return URLEncoder.encode(slug, StandardCharsets.UTF_8).replace("+", "%20");
    }
}
