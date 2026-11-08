package com.blog.bookmark.repository;

import com.blog.bookmark.entity.PostBookmark;
import com.blog.bookmark.entity.PostBookmarkId;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

/**
 * Bookmarks. Saving and unsaving are one SQL statement each, like PostLikeRepository; every statement filters by
 * the caller.
 */
public interface PostBookmarkRepository extends JpaRepository<PostBookmark, PostBookmarkId> {

    /** Saves, only if the post is still published when this runs; already saved is skipped. Returns 1 when inserted. */
    @Modifying
    @Query(value = """
            INSERT INTO post_bookmarks (user_id, post_id)
            SELECT :userId, p.id FROM posts p WHERE p.id = :postId AND p.status = 'PUBLISHED'
            ON CONFLICT (user_id, post_id) DO NOTHING""", nativeQuery = true)
    int saveIfPublished(UUID userId, UUID postId);

    @Modifying
    @Query(value = "DELETE FROM post_bookmarks WHERE user_id = :userId AND post_id = :postId", nativeQuery = true)
    int remove(UUID userId, UUID postId);

    /**
     * The post with this slug that the caller can unsave: published, or unpublished but still in their own
     * bookmarks (otherwise it would reappear when the post is published again). A draft they never saved returns
     * empty like an unknown slug, so draft slugs do not leak.
     */
    @Query("""
            select p.id from Post p
            where p.slug = :slug
              and (p.status = com.blog.post.entity.PostStatus.PUBLISHED
                   or exists (select 1 from PostBookmark b where b.id.userId = :userId and b.id.postId = p.id))""")
    Optional<UUID> findRemovablePostId(UUID userId, String slug);

    /**
     * Ids of bookmarked posts that are still published, most recently saved first; unpublished posts are filtered
     * out here and in the count query, their rows remain. Ids rather than Post: in Spring Data, a type other than
     * PostBookmark is a DTO, and its select clause may be rewritten.
     */
    @Query(value = """
            select b.id.postId from PostBookmark b join Post p on p.id = b.id.postId
            where b.id.userId = :userId and p.status = com.blog.post.entity.PostStatus.PUBLISHED
            order by b.createdAt desc, b.id.postId desc""", countQuery = """
            select count(*) from PostBookmark b join Post p on p.id = b.id.postId
            where b.id.userId = :userId and p.status = com.blog.post.entity.PostStatus.PUBLISHED""")
    Page<UUID> findPublishedPostIds(UUID userId, Pageable pageable);
}
