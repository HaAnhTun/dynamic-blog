package com.blog.comment.repository;

import com.blog.comment.entity.Comment;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

/**
 * Comments. The entity is read-only; insertion and every later change is a conditional SQL statement here, and
 * the number of rows it changes decides the outcome: when an author edit and an admin hide run at the same time,
 * neither overwrites the other's status, and no comment is added to a post that was just unpublished.
 */
public interface CommentRepository extends JpaRepository<Comment, UUID> {

    /**
     * The condition "this root comment is shown to readers": it is VISIBLE itself, or it was hidden or deleted but
     * still has at least one VISIBLE reply (then it is a placeholder). It lives inside the page-selecting query so
     * a page always holds the full number of displayable threads, and so the cursor only walks over what readers
     * see.
     */
    String AND_DISPLAYABLE_ROOT = """
              AND (c.status = 'VISIBLE'
                   OR EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = c.id AND r.status = 'VISIBLE'))
            """;

    /**
     * Ids of the displayable root comments of the first page, oldest first by {@code (created_at, id)}. The caller
     * asks for one extra row to learn whether a next page exists. Ids only: the entities are loaded with their
     * authors in {@link #findAllWithAuthorByIdIn}.
     */
    @Query(value = """
            SELECT c.id FROM comments c
            WHERE c.post_id = :postId AND c.parent_id IS NULL
            """ + AND_DISPLAYABLE_ROOT + """
            ORDER BY c.created_at, c.id
            LIMIT :limit""", nativeQuery = true)
    List<UUID> findRootIds(UUID postId, int limit);

    /**
     * Like {@link #findRootIds}, for the page after the cursor {@code (afterCreatedAt, afterId)}: a Postgres row
     * comparison, exactly one scan of the index {@code idx_comments_post_roots}. The cursor is a position, not a
     * comment, so even if the comment at that position is deleted between two loads the next page still starts in
     * the right place. A separate statement instead of a nullable cursor parameter: no need to bind an untyped null
     * into plain SQL.
     */
    @Query(value = """
            SELECT c.id FROM comments c
            WHERE c.post_id = :postId AND c.parent_id IS NULL
              AND (c.created_at, c.id) > (:afterCreatedAt, :afterId)
            """ + AND_DISPLAYABLE_ROOT + """
            ORDER BY c.created_at, c.id
            LIMIT :limit""", nativeQuery = true)
    List<UUID> findRootIdsAfter(UUID postId, Instant afterCreatedAt, UUID afterId, int limit);

    /** Comments with their authors in one query (join fetch); order is not guaranteed, the caller re-sorts. */
    @Query("select c from Comment c join fetch c.author where c.id in :ids")
    List<Comment> findAllWithAuthorByIdIn(Collection<UUID> ids);

    /**
     * Every VISIBLE reply of the given root comments, with authors, oldest first: one query for the whole page, not
     * one per thread. At most 30 replies per root, so a page of 20 roots reads at most 600 rows.
     */
    @Query("""
            select c from Comment c join fetch c.author
            where c.parentId in :rootIds and c.status = com.blog.comment.entity.CommentStatus.VISIBLE
            order by c.createdAt, c.id""")
    List<Comment> findVisibleRepliesWithAuthor(Collection<UUID> rootIds);

    @Query("select c from Comment c join fetch c.author where c.id = :id")
    Optional<Comment> findWithAuthorById(UUID id);

    /** The state of a comment and its post, for the 404 then 403 checks before an edit or delete. */
    @Query(value = """
            SELECT c.id AS "id", c.post_id AS "postId", c.user_id AS "userId", c.parent_id AS "parentId",
                   c.content AS "content", c.status AS "status", p.status AS "postStatus"
            FROM comments c JOIN posts p ON p.id = c.post_id
            WHERE c.id = :id""", nativeQuery = true)
    Optional<CommentStateRow> findState(UUID id);

    /**
     * A FOR KEY SHARE lock on the post row of a comment, held until the end of the transaction: exactly the lock
     * the foreign-key check on {@code post_id} of the reply INSERT would take, only taken earlier, before the lock
     * on the parent comment ({@link #findStateForUpdate}).
     *
     * That order matches the order of a hard delete of a post (PostService.delete): the post row first, then
     * ON DELETE CASCADE locks each comment of the post. Without this statement, a reply would hold the parent
     * comment lock and only then request the post row (at INSERT), while a post delete holds the post row and then
     * requests the parent comment: the two wait for each other, Postgres aborts one (40P01) and the caller gets
     * 500. It blocks nothing more than before: it is still the weakest lock, the one the foreign-key check takes
     * anyway; unpublishing or archiving a post (FOR NO KEY UPDATE) does not wait for it, deleting a post does.
     *
     * @return the post id; empty when the comment does not exist, or its post was just deleted while waiting for
     *         the lock (READ COMMITTED skips rows deleted by the time the lock is released)
     */
    @Query(value = """
            SELECT p.id FROM posts p
            WHERE p.id = (SELECT c.post_id FROM comments c WHERE c.id = :commentId)
            FOR KEY SHARE OF p""", nativeQuery = true)
    Optional<UUID> lockPostOfComment(UUID commentId);

    /**
     * Like {@link #findState}, plus a write lock on the comment row (not on the post), held until the end of the
     * transaction: the parent comment of a reply. Every reply to the same root queues behind this lock, so the
     * 30-reply limit counts correctly even when many people reply at once, and an admin hiding or deleting the root
     * cannot slip in between the check and the insert. FOR NO KEY UPDATE, exactly the lock a status UPDATE takes:
     * it does not block the foreign-key check (FOR KEY SHARE) of replies being inserted. The caller locks the post
     * row first ({@link #lockPostOfComment}).
     */
    @Query(value = """
            SELECT c.id AS "id", c.post_id AS "postId", c.user_id AS "userId", c.parent_id AS "parentId",
                   c.content AS "content", c.status AS "status", p.status AS "postStatus"
            FROM comments c JOIN posts p ON p.id = c.post_id
            WHERE c.id = :id
            FOR NO KEY UPDATE OF c""", nativeQuery = true)
    Optional<CommentStateRow> findStateForUpdate(UUID id);

    /**
     * An advisory lock per user for creating comments (root and reply), held until the end of the transaction.
     * Checking "just sent this exact comment" and then inserting is a read followed by a write: without the lock,
     * two simultaneous submits both see nothing and both insert. With the lock, the second waits for the first to
     * commit and then sees its comment. Per user rather than per post: other users never have to wait.
     */
    @Query(
            value = "SELECT 1 FROM pg_advisory_xact_lock(hashtext('comment-create'), hashtext(CAST(:userId AS text)))",
            nativeQuery = true)
    int lockCreateFor(UUID userId);

    /**
     * This user already submitted this exact content as a root comment on this post within the last 10 minutes, and
     * has not deleted it. Runs after {@link #lockCreateFor}.
     */
    @Query(value = """
            SELECT EXISTS (SELECT 1 FROM comments c
                           WHERE c.user_id = :userId AND c.post_id = :postId AND c.parent_id IS NULL
                             AND c.content = :content AND c.status <> 'DELETED'
                             AND c.created_at > now() - INTERVAL '10 minutes')""", nativeQuery = true)
    boolean existsRecentRootDuplicate(UUID userId, UUID postId, String content);

    /**
     * Like {@link #existsRecentRootDuplicate}, for replies to exactly this parent comment: the same short sentence
     * ("Thanks!") replying to two different people is not a duplicate submit.
     */
    @Query(value = """
            SELECT EXISTS (SELECT 1 FROM comments c
                           WHERE c.user_id = :userId AND c.parent_id = :parentId
                             AND c.content = :content AND c.status <> 'DELETED'
                             AND c.created_at > now() - INTERVAL '10 minutes')""", nativeQuery = true)
    boolean existsRecentReplyDuplicate(UUID userId, UUID parentId, String content);

    /** Number of replies of a root comment, any status: hidden or deleted replies still count toward the limit of 30. */
    @Query("select count(c) from Comment c where c.parentId = :parentId")
    long countReplies(UUID parentId);

    /**
     * Inserts a root comment, only if the post is still published at the moment this runs (like
     * PostLikeRepository.likeIfPublished). The post check at the start of the create may be stale by now,
     * especially when the submit had to wait for the per-user lock ({@link #lockCreateFor}); this statement runs
     * with a fresh snapshot, so an unpublish committed before it is always seen. Takes no extra lock: unpublishing
     * a post never waits for any comment.
     *
     * @param createdAt truncated to microseconds, the precision Postgres stores: the keyset cursor
     *                  {@code (created_at, id)} compares this value exactly
     * @return 1 when inserted; 0 when the post was unpublished, archived or deleted after the caller's check
     */
    @Modifying
    @Query(value = """
            INSERT INTO comments (id, post_id, user_id, parent_id, content, created_at, updated_at)
            SELECT :id, p.id, :userId, NULL, :content, :createdAt, :createdAt
            FROM posts p WHERE p.id = :postId AND p.status = 'PUBLISHED'""", nativeQuery = true)
    int insertRootIfPublished(UUID id, UUID postId, UUID userId, String content, Instant createdAt);

    /**
     * Like {@link #insertRootIfPublished}, for a reply. A separate statement instead of a nullable {@code parentId}
     * parameter: no need to bind an untyped null into plain SQL. The FOR KEY SHARE lock on the post row
     * ({@link #lockPostOfComment}) does not block unpublishing, so the post status must be re-checked in the insert
     * itself.
     *
     * @return 1 when inserted; 0 when the parent comment's post was unpublished or archived after the caller's check
     */
    @Modifying
    @Query(value = """
            INSERT INTO comments (id, post_id, user_id, parent_id, content, created_at, updated_at)
            SELECT :id, p.id, :userId, :parentId, :content, :createdAt, :createdAt
            FROM posts p WHERE p.id = :postId AND p.status = 'PUBLISHED'""", nativeQuery = true)
    int insertReplyIfPublished(UUID id, UUID postId, UUID userId, UUID parentId, String content, Instant createdAt);

    /**
     * The author edits the content: only their own comment, currently VISIBLE, on a published post, with content
     * that actually differs.
     *
     * @return 1 when edited; 0 when a condition no longer holds at write time (hidden or deleted, post unpublished
     *         right after the check), or the content is identical. The caller reads again to tell which case it is.
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(value = """
            UPDATE comments c SET content = :content, edited_at = now(), updated_at = now()
            WHERE c.id = :id AND c.user_id = :userId AND c.status = 'VISIBLE' AND c.content <> :content
              AND EXISTS (SELECT 1 FROM posts p WHERE p.id = c.post_id AND p.status = 'PUBLISHED')""", nativeQuery = true)
    int editOwnIfVisible(UUID id, UUID userId, String content);

    /**
     * The author soft-deletes their own comment: only while it is VISIBLE. The content is kept for moderation.
     *
     * @return 1 when deleted; 0 when it was just hidden or deleted (including a repeated delete)
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(value = """
            UPDATE comments SET status = 'DELETED', updated_at = now()
            WHERE id = :id AND user_id = :userId AND status = 'VISIBLE'""", nativeQuery = true)
    int softDeleteOwnIfVisible(UUID id, UUID userId);

    // --- Admin moderation: every comment, every post, including unpublished posts. Each statement changes only its
    // own source status, so none overwrites another change that was just committed: a delete by the author or by an
    // admin is never turned into HIDDEN or VISIBLE by a hide or restore arriving later. DELETED is the final state.

    /**
     * An admin hides a visible comment.
     *
     * @return 1 when hidden; 0 when the comment does not exist, is already hidden, or is deleted. The caller reads
     *         again to tell which case it is.
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(value = """
            UPDATE comments SET status = 'HIDDEN', updated_at = now()
            WHERE id = :id AND status = 'VISIBLE'""", nativeQuery = true)
    int hideIfVisible(UUID id);

    /**
     * An admin shows a hidden comment again. Never touches a deleted comment.
     *
     * @return 1 when shown again; 0 when the comment does not exist, is already visible, or is deleted
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(value = """
            UPDATE comments SET status = 'VISIBLE', updated_at = now()
            WHERE id = :id AND status = 'HIDDEN'""", nativeQuery = true)
    int restoreIfHidden(UUID id);

    /**
     * An admin soft-deletes a comment, visible or hidden. The content is kept as moderation history.
     *
     * @return 1 when deleted; 0 when the comment does not exist or was already deleted
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query(value = """
            UPDATE comments SET status = 'DELETED', updated_at = now()
            WHERE id = :id AND status <> 'DELETED'""", nativeQuery = true)
    int softDeleteUnlessDeleted(UUID id);
}
