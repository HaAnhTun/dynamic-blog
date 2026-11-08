package com.blog.notification.service;

import com.blog.notification.repository.NotificationRepository;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Creates notifications. Each method is called right after a write that really happened (a like was just
 * inserted, a comment was just inserted), and runs in the SAME transaction as that write ({@code REQUIRED}):
 * <ul>
 *   <li>if the write rolls back there are no orphan notifications, and there is never a notification for a like
 *       that was rolled back;</li>
 *   <li>if the notification insert fails, the whole request rolls back (500 {@code INTERNAL_ERROR}). In Postgres a
 *       failed statement poisons the whole transaction, so "skip and carry on" would need a savepoint; but each
 *       statement is just an indexed insert over rows the transaction has already touched, so if it fails the DB is
 *       already broken, and the like could not succeed anyway.</li>
 * </ul>
 * No {@code @Async}, no events. "No self-notification", "only published posts", "only VISIBLE comments" live in the
 * SQL statements themselves (NotificationRepository), not here.
 *
 * Every statement only joins rows the transaction already holds (post, comment, the two users), so it adds no new
 * lock ordering to the existing write paths.
 */
@Service
@RequiredArgsConstructor
public class NotificationWriter {

    private final NotificationRepository notificationRepository;

    /** After a post like was just inserted (not a repeated like of an already liked post). */
    @Transactional
    public void postLiked(UUID actorId, UUID postId) {
        notificationRepository.notifyPostLiked(actorId, postId);
    }

    /** After a comment like was just inserted. */
    @Transactional
    public void commentLiked(UUID actorId, UUID commentId) {
        notificationRepository.notifyCommentLiked(actorId, commentId);
    }

    /**
     * After a root comment or a reply was just inserted. The actor is always the author of that comment, read from
     * the row just inserted: a reply notifies the author of the parent comment, and both kinds notify the post's
     * author, unless the author was already notified by the reply notification.
     */
    @Transactional
    public void commentCreated(UUID commentId) {
        notificationRepository.notifyCommentReplied(commentId);
        notificationRepository.notifyPostCommented(commentId);
    }
}
