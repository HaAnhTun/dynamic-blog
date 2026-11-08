package com.blog.notification.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/**
 * A notification ({@code notifications}, V22).
 *
 * The entity exists only so Spring Data has a place to hang the queries of NotificationRepository and so
 * {@code ddl-auto: validate} can check the table: no path saves it. Insertion is a conditional
 * {@code INSERT ... SELECT} (no self-notification, published posts only), and marking as read and deleting are
 * conditional SQL statements scoped to the recipient. That is why EVERY column is updatable = false, and there are
 * no relations: reads join straight to users, posts and comments in SQL.
 */
@Entity
@Table(name = "notifications")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class Notification {

    @Id
    @Column(updatable = false)
    private UUID id;

    @Column(name = "recipient_id", nullable = false, updatable = false)
    private UUID recipientId;

    @Column(name = "actor_id", nullable = false, updatable = false)
    private UUID actorId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, updatable = false, length = 30)
    private NotificationType type;

    @Column(name = "post_id", nullable = false, updatable = false)
    private UUID postId;

    /** Null for POST_LIKED; the other three types always have it (CHECK chk_notifications_comment). */
    @Column(name = "comment_id", updatable = false)
    private UUID commentId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    /** Null when unread. */
    @Column(name = "read_at", updatable = false)
    private Instant readAt;
}
