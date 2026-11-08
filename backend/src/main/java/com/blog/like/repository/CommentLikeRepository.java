package com.blog.like.repository;

import com.blog.like.entity.CommentLike;
import com.blog.like.entity.CommentLikeId;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

/**
 * Comment likes, done the same way as PostLikeRepository: liking and unliking are one SQL statement each, not a
 * read followed by a write through the entity, so pressing like many times at once still yields exactly one row
 * and never throws a duplicate-key error.
 */
public interface CommentLikeRepository extends JpaRepository<CommentLike, CommentLikeId> {

    /**
     * Likes a comment, only if it is still VISIBLE on a published post at the moment this runs. If already liked,
     * the primary key blocks it and {@code ON CONFLICT DO NOTHING} skips it.
     *
     * @return 1 when just inserted; 0 when already liked, OR the comment was just hidden or deleted or its post
     *         unpublished after the caller's check. As with PostLikeRepository.likeIfPublished, the caller reads the
     *         like and then the status again to tell which case it is.
     */
    @Modifying
    @Query(value = """
            INSERT INTO comment_likes (comment_id, user_id)
            SELECT c.id, :userId FROM comments c JOIN posts p ON p.id = c.post_id
            WHERE c.id = :commentId AND c.status = 'VISIBLE' AND p.status = 'PUBLISHED'
            ON CONFLICT (comment_id, user_id) DO NOTHING""", nativeQuery = true)
    int likeIfVisible(UUID commentId, UUID userId);

    /** Unlike; 0 when not liked is also a success. */
    @Modifying
    @Query(value = "DELETE FROM comment_likes WHERE comment_id = :commentId AND user_id = :userId", nativeQuery = true)
    int unlike(UUID commentId, UUID userId);

    @Query("select count(l) from CommentLike l where l.id.commentId = :commentId")
    long countByCommentId(UUID commentId);

    /**
     * Like counts of many comments in one query: one statement for a whole page of comments, however many threads
     * and replies it has. A comment nobody liked has no row.
     */
    @Query("""
            select l.id.commentId as commentId, count(l) as likes from CommentLike l
            where l.id.commentId in :commentIds
            group by l.id.commentId""")
    List<CommentLikeCountRow> countByCommentIdIn(Collection<UUID> commentIds);

    /** Of the given comments, the ones this user liked: {@code likedByMe} for a whole page in one query. */
    @Query("select l.id.commentId from CommentLike l where l.id.userId = :userId and l.id.commentId in :commentIds")
    List<UUID> likedAmong(UUID userId, Collection<UUID> commentIds);
}
