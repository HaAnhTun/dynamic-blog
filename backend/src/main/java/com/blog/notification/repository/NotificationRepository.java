package com.blog.notification.repository;

import com.blog.notification.entity.Notification;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

/**
 * Notifications. Every write is a conditional SQL statement, not going through the entity:
 * <ul>
 *   <li>insertion is {@code INSERT ... SELECT}: "no self-notification", "post is published", "comment is still
 *       VISIBLE" sit inside the statement itself, not in an earlier read, so there is no gap between the check and
 *       the write;</li>
 *   <li>like notifications use {@code ON CONFLICT ... DO NOTHING} on a partial unique index: like, unlike, like
 *       again is still one row, keeping its timestamp and read state;</li>
 *   <li>marking as read and deleting always carry {@code recipient_id = :me}: nobody can touch another user's
 *       notifications.</li>
 * </ul>
 */
public interface NotificationRepository extends JpaRepository<Notification, UUID> {

    /** The returned unread count never exceeds this number: the bell only shows "99+". */
    int UNREAD_COUNT_CAP = 100;

    /**
     * Which notifications the recipient can still see, shared by the list, the unread filter and the unread count:
     * filtered at read time rather than deleted, so when a post is republished, a comment is shown again, or a like
     * is liked again, their notifications reappear.
     * <ul>
     *   <li>the post must be published;</li>
     *   <li>the comment tied to the notification (the actor's for POST_COMMENTED and COMMENT_REPLIED, the
     *       recipient's own for COMMENT_LIKED) must still be VISIBLE;</li>
     *   <li>a like notification shows only while the like still exists: unliking does not delete the notification,
     *       it only hides it.</li>
     * </ul>
     * Use only after {@code FROM notifications n}, with the parameter {@code :me}.
     */
    String VISIBLE_NOTIFICATION = """
            JOIN users a ON a.id = n.actor_id
            JOIN posts p ON p.id = n.post_id AND p.status = 'PUBLISHED'
            LEFT JOIN comments c ON c.id = n.comment_id
            WHERE n.recipient_id = :me
              AND (n.comment_id IS NULL OR c.status = 'VISIBLE')
              AND (n.type <> 'POST_LIKED'
                   OR EXISTS (SELECT 1 FROM post_likes l WHERE l.post_id = n.post_id AND l.user_id = n.actor_id))
              AND (n.type <> 'COMMENT_LIKED'
                   OR EXISTS (SELECT 1 FROM comment_likes l WHERE l.comment_id = n.comment_id AND l.user_id = n.actor_id))
            """;

    /** The columns of a {@link NotificationRow}. */
    String SELECT_ROW = """
            SELECT n.id AS "id", n.type AS "type", n.created_at AS "createdAt", n.read_at IS NOT NULL AS "read",
                   a.display_name AS "actorDisplayName", a.github_login AS "actorGithubLogin",
                   a.avatar_url AS "actorAvatarUrl", p.slug AS "postSlug", p.title AS "postTitle",
                   n.comment_id AS "commentId", c.content AS "commentContent"
            FROM notifications n
            """;

    /** Newest first; two notifications with the same timestamp (same transaction) are ordered by id. */
    String NEWEST_FIRST = """
            ORDER BY n.created_at DESC, n.id DESC
            LIMIT :limit""";

    // --- Insert ----------------------------------------------------------------------------------------

    /**
     * Someone just liked a post: notifies the post's author, unless the author liked it themselves, and only while
     * the post is published. If a notification from this exact user for this exact post already exists (like, unlike,
     * like again), nothing is added.
     *
     * @return 1 when inserted; 0 for a self-like, a post no longer published, or an existing notification
     */
    @Modifying
    @Query(value = """
            INSERT INTO notifications (recipient_id, actor_id, type, post_id)
            SELECT p.author_id, :actorId, 'POST_LIKED', p.id FROM posts p
            WHERE p.id = :postId AND p.status = 'PUBLISHED' AND p.author_id <> :actorId
            ON CONFLICT (recipient_id, actor_id, post_id) WHERE type = 'POST_LIKED' DO NOTHING""", nativeQuery = true)
    int notifyPostLiked(UUID actorId, UUID postId);

    /**
     * Someone just liked a comment: notifies its author, unless it is a self-like, and only while the comment is
     * VISIBLE on a published post. Like {@link #notifyPostLiked}, at most one notification per (liker, comment).
     */
    @Modifying
    @Query(value = """
            INSERT INTO notifications (recipient_id, actor_id, type, post_id, comment_id)
            SELECT c.user_id, :actorId, 'COMMENT_LIKED', c.post_id, c.id
            FROM comments c JOIN posts p ON p.id = c.post_id
            WHERE c.id = :commentId AND c.status = 'VISIBLE' AND p.status = 'PUBLISHED' AND c.user_id <> :actorId
            ON CONFLICT (recipient_id, actor_id, comment_id) WHERE type = 'COMMENT_LIKED' DO NOTHING""", nativeQuery = true)
    int notifyCommentLiked(UUID actorId, UUID commentId);

    /**
     * A reply was just added: notifies the author of the parent comment, unless they replied to themselves, and
     * only while the post is published (like the two like statements: if the post is unpublished right after the
     * reply insert, nobody is notified). A root comment selects no row (it has no parent). Each reply is its own
     * event: no de-duplication.
     */
    @Modifying
    @Query(value = """
            INSERT INTO notifications (recipient_id, actor_id, type, post_id, comment_id)
            SELECT parent.user_id, c.user_id, 'COMMENT_REPLIED', c.post_id, c.id
            FROM comments c JOIN comments parent ON parent.id = c.parent_id JOIN posts p ON p.id = c.post_id
            WHERE c.id = :commentId AND p.status = 'PUBLISHED' AND parent.user_id <> c.user_id""", nativeQuery = true)
    int notifyCommentReplied(UUID commentId);

    /**
     * A comment (root or reply) was just added: notifies the post's author, only while the post is published,
     * unless the author wrote it themselves, or it is a reply to the author's own comment: then
     * {@link #notifyCommentReplied} already notified them, and one notification is enough.
     */
    @Modifying
    @Query(value = """
            INSERT INTO notifications (recipient_id, actor_id, type, post_id, comment_id)
            SELECT p.author_id, c.user_id, 'POST_COMMENTED', c.post_id, c.id
            FROM comments c JOIN posts p ON p.id = c.post_id LEFT JOIN comments parent ON parent.id = c.parent_id
            WHERE c.id = :commentId AND p.status = 'PUBLISHED' AND p.author_id <> c.user_id
              AND (parent.id IS NULL OR parent.user_id <> p.author_id)""", nativeQuery = true)
    int notifyPostCommented(UUID commentId);

    // --- Read ------------------------------------------------------------------------------------------

    /** The first page, newest first. The caller asks for one extra row to learn whether a next page exists. */
    @Query(value = SELECT_ROW + VISIBLE_NOTIFICATION + NEWEST_FIRST, nativeQuery = true)
    List<NotificationRow> findPage(UUID me, int limit);

    /**
     * The page after the cursor {@code (beforeCreatedAt, beforeId)}: a Postgres row comparison on the index
     * {@code idx_notifications_recipient}. A separate statement instead of a nullable cursor, like CommentRepository.
     */
    @Query(value = SELECT_ROW + VISIBLE_NOTIFICATION + """
              AND (n.created_at, n.id) < (:beforeCreatedAt, :beforeId)
            """ + NEWEST_FIRST, nativeQuery = true)
    List<NotificationRow> findPageBefore(UUID me, Instant beforeCreatedAt, UUID beforeId, int limit);

    /** Like {@link #findPage}, unread notifications only (partial index {@code idx_notifications_recipient_unread}). */
    @Query(value = SELECT_ROW + VISIBLE_NOTIFICATION + """
              AND n.read_at IS NULL
            """ + NEWEST_FIRST, nativeQuery = true)
    List<NotificationRow> findUnreadPage(UUID me, int limit);

    @Query(value = SELECT_ROW + VISIBLE_NOTIFICATION + """
              AND n.read_at IS NULL AND (n.created_at, n.id) < (:beforeCreatedAt, :beforeId)
            """ + NEWEST_FIRST, nativeQuery = true)
    List<NotificationRow> findUnreadPageBefore(UUID me, Instant beforeCreatedAt, UUID beforeId, int limit);

    /**
     * The number of unread notifications the recipient can still see, capped at {@link #UNREAD_COUNT_CAP}. LIMIT
     * caps the result, not the scan: filtered-out notifications are still walked over, which is acceptable with a
     * partial index per recipient.
     */
    @Query(
            value = "SELECT count(*) FROM (SELECT 1 FROM notifications n " + VISIBLE_NOTIFICATION
                    + "  AND n.read_at IS NULL LIMIT " + UNREAD_COUNT_CAP + ") unread",
            nativeQuery = true)
    long countUnread(UUID me);

    // --- Mark as read, delete: only the caller's own notifications --------------------------------------

    /**
     * Marks one notification as read. If already read, the old read time is kept.
     *
     * @return 1 when just marked; 0 when already read, missing, or someone else's (the caller tells them apart with
     *         {@link #existsByIdAndRecipientId})
     */
    @Modifying
    @Query(value = """
            UPDATE notifications SET read_at = now()
            WHERE id = :id AND recipient_id = :me AND read_at IS NULL""", nativeQuery = true)
    int markRead(UUID id, UUID me);

    boolean existsByIdAndRecipientId(UUID id, UUID recipientId);

    /** Every unread notification of the caller, including those currently filtered out. */
    @Modifying
    @Query(
            value = "UPDATE notifications SET read_at = now() WHERE recipient_id = :me AND read_at IS NULL",
            nativeQuery = true)
    int markAllRead(UUID me);

    /**
     * Like {@link #markAllRead}, only up to the position {@code (upToCreatedAt, upToId)}, inclusive: notifications
     * that arrived after the list was loaded stay unread, the reader has not seen them yet.
     */
    @Modifying
    @Query(value = """
            UPDATE notifications SET read_at = now()
            WHERE recipient_id = :me AND read_at IS NULL AND (created_at, id) <= (:upToCreatedAt, :upToId)""", nativeQuery = true)
    int markAllReadUpTo(UUID me, Instant upToCreatedAt, UUID upToId);

    /** @return 1 when deleted; 0 when missing, or someone else's */
    @Modifying
    @Query(value = "DELETE FROM notifications WHERE id = :id AND recipient_id = :me", nativeQuery = true)
    int deleteOwn(UUID id, UUID me);
}
