package com.blog.comment.mapper;

import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Likes for a group of comments as one viewer sees them: the like count of each comment, and the comments the
 * viewer themselves liked. Read in batches, two queries for a whole page however large it is (CommentService),
 * then {@link CommentMapper} looks each comment up here.
 *
 * @param counts        comment id to like count; missing means 0
 * @param likedByViewer ids of the comments the viewer liked; always empty for anonymous viewers
 */
public record CommentLikeStats(Map<UUID, Long> counts, Set<UUID> likedByViewer) {

    /** Nobody liked anything: a freshly created comment. */
    public static final CommentLikeStats EMPTY = new CommentLikeStats(Map.of(), Set.of());

    public CommentLikeStats {
        counts = Map.copyOf(counts);
        likedByViewer = Set.copyOf(likedByViewer);
    }

    long countOf(UUID commentId) {
        return counts.getOrDefault(commentId, 0L);
    }

    boolean isLikedByViewer(UUID commentId) {
        return likedByViewer.contains(commentId);
    }
}
