package com.blog.like.repository;

import com.blog.like.entity.PostLike;
import com.blog.like.entity.PostLikeId;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

/**
 * Likes. Liking and unliking are one SQL statement each, not a read followed by a write through the entity: two
 * simultaneous likes by one user still yield exactly one row, and neither throws a duplicate-key error.
 */
public interface PostLikeRepository extends JpaRepository<PostLike, PostLikeId> {

    /**
     * Likes a post, only if it is still published at the moment this runs (following the precedent of
     * PostViewRepository.incrementBySlug). If already liked, the primary key blocks it and
     * {@code ON CONFLICT DO NOTHING} skips it.
     *
     * @return 1 when just inserted; 0 when already liked, OR the post was unpublished after the caller's check.
     *         {@code DO NOTHING} does not lock the old like, so it can still be removed right after this statement.
     *         The caller reads the like, then the post status, to tell which case it is: never report "liked" for a
     *         like that does not exist.
     */
    @Modifying
    @Query(value = """
            INSERT INTO post_likes (post_id, user_id)
            SELECT p.id, :userId FROM posts p WHERE p.id = :postId AND p.status = 'PUBLISHED'
            ON CONFLICT (post_id, user_id) DO NOTHING""", nativeQuery = true)
    int likeIfPublished(UUID postId, UUID userId);

    /** Unlike; 0 when not liked is also a success. */
    @Modifying
    @Query(value = "DELETE FROM post_likes WHERE post_id = :postId AND user_id = :userId", nativeQuery = true)
    int unlike(UUID postId, UUID userId);

    @Query("select count(l) from PostLike l where l.id.postId = :postId")
    long countByPostId(UUID postId);
}
