package com.blog.post.repository;

import com.blog.post.dto.PostRevisionSummaryResponse;
import com.blog.post.entity.PostRevision;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

/**
 * Revisions of a post. Every read is for one post, newest first, matching the order of the index
 * {@code idx_post_revisions_post_created}; ties on time are broken by id, so the order is deterministic both in the list
 * and in the statement that keeps the latest 20.
 */
public interface PostRevisionRepository extends JpaRepository<PostRevision, UUID> {

    /** Whether the post has any revision written after {@code since}: the window that coalesces consecutive saves. */
    boolean existsByPostIdAndCreatedAtAfter(UUID postId, Instant since);

    /** The history list, newest first: a projection, which reads no revision's content. */
    @Query("""
            select new com.blog.post.dto.PostRevisionSummaryResponse(r.id, r.title, r.createdAt)
            from PostRevision r
            where r.postId = :postId
            order by r.createdAt desc, r.id desc""")
    List<PostRevisionSummaryResponse> findSummariesByPostId(UUID postId);

    /** A revision if and only if it belongs to this post: the id of another post's revision is as empty as an unknown id. */
    Optional<PostRevision> findByIdAndPostId(UUID id, UUID postId);

    /**
     * Deletes every revision of the post except the {@code keep} newest. Flushes first: the revision just {@code save}d
     * in the same transaction must be in the table when this statement counts. Does not clear: the post being edited must
     * stay in the persistence context (managed) so that its save reaches the DB at commit, like the slug history
     * statements in PostRepository.
     */
    @Modifying(flushAutomatically = true)
    @Query(value = """
            delete from post_revisions
            where post_id = :postId
              and id not in (select id from post_revisions
                             where post_id = :postId
                             order by created_at desc, id desc
                             limit :keep)""", nativeQuery = true)
    int deleteAllButNewest(UUID postId, int keep);
}
