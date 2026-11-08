package com.blog.notification.entity;

/**
 * Notification type ({@code notifications.type}, V22). The recipient is never the user who caused it.
 *
 * POST_LIKED and POST_COMMENTED go to the post's author; COMMENT_REPLIED goes to the author of the comment that was
 * replied to; COMMENT_LIKED goes to the author of the comment that was liked. Only POST_LIKED is not tied to a
 * comment.
 */
public enum NotificationType {
    POST_LIKED,
    POST_COMMENTED,
    COMMENT_REPLIED,
    COMMENT_LIKED
}
