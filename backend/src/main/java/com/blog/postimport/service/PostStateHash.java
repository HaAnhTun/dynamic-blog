package com.blog.postimport.service;

import com.blog.post.entity.Post;
import com.blog.postimport.format.PostFile;
import com.blog.postimport.format.PostNormalForm;
import com.blog.tag.entity.Tag;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

/**
 * The hash of the stored state of a post that the import keeps: in the preview state, to see whether a post is still as the
 * preview showed it, and in the import log, to see whether a post is still as the import left it. SHA-256 over a canonical
 * encoding of the title, excerpt, content (in its normal form), language, slug, status, publication time, category id and the
 * sorted tag ids, then, for a post that is in a series, the series id, the position and the declared part. Every field is written as its length, a colon and its value (a null as {@code -}), so no two different
 * states give the same bytes. The hash holds nothing readable: the text cannot be read back from it.
 */
public final class PostStateHash {

    private PostStateHash() {}

    public static String of(Post post) {
        List<UUID> tagIds = post.getTags().stream().map(Tag::getId).toList();
        return of(
                post.getTitle(),
                post.getExcerpt(),
                post.getContent(),
                post.getLanguage(),
                post.getSlug(),
                post.getStatus() == null ? null : post.getStatus().name(),
                post.getPublishedAt(),
                post.getCategory() == null ? null : post.getCategory().getId(),
                tagIds,
                post.getSeries() == null ? null : post.getSeries().getId(),
                post.getSeriesPosition(),
                post.getSeriesPart(),
                post.getCover() == null ? null : post.getCover().getId(),
                post.getCover() == null ? null : post.getCover().getAltText());
    }

    /** A post outside any series. */
    public static String of(
            String title,
            String excerpt,
            String content,
            String language,
            String slug,
            String status,
            Instant publishedAt,
            UUID categoryId,
            Collection<UUID> tagIds) {
        return of(title, excerpt, content, language, slug, status, publishedAt, categoryId, tagIds, null, null, null);
    }

    /** A post with no cover: the hash it had before covers were part of it. */
    public static String of(
            String title,
            String excerpt,
            String content,
            String language,
            String slug,
            String status,
            Instant publishedAt,
            UUID categoryId,
            Collection<UUID> tagIds,
            UUID seriesId,
            Integer seriesPosition,
            Integer seriesPart) {
        return of(
                title,
                excerpt,
                content,
                language,
                slug,
                status,
                publishedAt,
                categoryId,
                tagIds,
                seriesId,
                seriesPosition,
                seriesPart,
                null,
                null);
    }

    /**
     * The series, the position in it and the declared part are written after the other fields and only for a post that is in a
     * series, so the hash of a post outside any series is the one it always had. The cover (the id of the image and its
     * description) comes last and only for a post that has one, for the same reason: a change of the cover between a preview
     * and an apply makes the apply out of date.
     */
    public static String of(
            String title,
            String excerpt,
            String content,
            String language,
            String slug,
            String status,
            Instant publishedAt,
            UUID categoryId,
            Collection<UUID> tagIds,
            UUID seriesId,
            Integer seriesPosition,
            Integer seriesPart,
            UUID coverId,
            String coverAlt) {
        StringBuilder canonical = new StringBuilder();
        field(canonical, title);
        field(canonical, excerpt);
        field(canonical, content == null ? null : PostNormalForm.content(content));
        field(canonical, language);
        field(canonical, slug);
        field(canonical, status);
        field(canonical, publishedAt == null ? null : publishedAt.toString());
        field(canonical, categoryId == null ? null : categoryId.toString());
        field(
                canonical,
                tagIds.stream()
                        .map(UUID::toString)
                        .sorted()
                        .reduce((a, b) -> a + "," + b)
                        .orElse(""));
        if (seriesId != null) {
            field(canonical, seriesId.toString());
            field(canonical, seriesPosition == null ? null : seriesPosition.toString());
            field(canonical, seriesPart == null ? null : seriesPart.toString());
        }
        if (coverId != null) {
            field(canonical, coverId.toString());
            field(canonical, coverAlt);
        }
        return PostFile.sha256Hex(canonical.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void field(StringBuilder canonical, String value) {
        if (value == null) {
            canonical.append('-');
        } else {
            canonical.append(value.length()).append(':').append(value);
        }
        canonical.append('\n');
    }
}
