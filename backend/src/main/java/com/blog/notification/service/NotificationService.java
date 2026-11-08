package com.blog.notification.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.notification.dto.NotificationActorResponse;
import com.blog.notification.dto.NotificationPage;
import com.blog.notification.dto.NotificationPostResponse;
import com.blog.notification.dto.NotificationResponse;
import com.blog.notification.dto.UnreadCountResponse;
import com.blog.notification.repository.NotificationRepository;
import com.blog.notification.repository.NotificationRow;
import com.blog.user.service.CurrentUserService;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The notification inbox of the signed-in user: paged reads, unread count, mark as read, delete.
 *
 * Every operation calls {@link CurrentUserService#requireActive()} first, like every reader write: a suspended user
 * gets 403 {@code USER_SUSPENDED} even for reads, because the inbox belongs to the account and is not public data.
 * Every statement only touches rows whose {@code recipient_id} is the caller; someone else's id is 404, never 403,
 * so it does not reveal whether that notification exists.
 *
 * No rate limit: these operations only read or change the caller's own rows, each write is a conditional
 * statement on an index and repeating it changes nothing, and the bell only polls about once a minute per tab.
 */
@Service
@RequiredArgsConstructor
public class NotificationService {

    static final int MAX_PAGE_SIZE = 50;

    private final NotificationRepository notificationRepository;
    private final CurrentUserService currentUserService;

    /**
     * One page of notifications that are still visible, newest first.
     *
     * @param after  cursor of the previous page ({@link NotificationPage#nextCursor()}); null or empty means the first page
     * @param size   clamped to 1..50
     * @param unread only unread notifications
     * @throws ApiException 401, 403 {@code USER_SUSPENDED}; 400 {@code VALIDATION_ERROR} when the cursor is malformed
     */
    @Transactional(readOnly = true)
    public NotificationPage list(String after, int size, boolean unread) {
        UUID me = currentUserService.requireActive();
        int pageSize = Math.clamp(size, 1, MAX_PAGE_SIZE);
        NotificationCursor cursor = NotificationCursor.decode(after);
        int limit = pageSize + 1;
        List<NotificationRow> rows;
        if (cursor == null) {
            rows = unread
                    ? notificationRepository.findUnreadPage(me, limit)
                    : notificationRepository.findPage(me, limit);
        } else {
            rows = unread
                    ? notificationRepository.findUnreadPageBefore(me, cursor.createdAt(), cursor.id(), limit)
                    : notificationRepository.findPageBefore(me, cursor.createdAt(), cursor.id(), limit);
        }
        // The extra row only tells us a next page exists: it opens the next page and does not belong to this one.
        boolean hasMore = rows.size() > pageSize;
        List<NotificationRow> page = hasMore ? rows.subList(0, pageSize) : rows;
        String nextCursor = hasMore ? NotificationCursor.of(page.getLast()).encode() : null;
        String headCursor = cursor == null && !page.isEmpty()
                ? NotificationCursor.of(page.getFirst()).encode()
                : null;
        return new NotificationPage(
                page.stream().map(NotificationService::toResponse).toList(), nextCursor, headCursor);
    }

    /** @throws ApiException 401, 403 {@code USER_SUSPENDED} */
    @Transactional(readOnly = true)
    public UnreadCountResponse unreadCount() {
        return unreadCount(currentUserService.requireActive());
    }

    /**
     * Marks one notification as read (the reader just opened it). Already read is still 200, even when it is
     * currently filtered out of the list: repeating changes nothing.
     *
     * @throws ApiException 401, 403 {@code USER_SUSPENDED}; 404 {@code NOTIFICATION_NOT_FOUND} when missing, or
     *                      someone else's
     */
    @Transactional
    public UnreadCountResponse markRead(UUID id) {
        UUID me = currentUserService.requireActive();
        if (notificationRepository.markRead(id, me) == 0 && !notificationRepository.existsByIdAndRecipientId(id, me)) {
            throw notFound(id);
        }
        return unreadCount(me);
    }

    /**
     * Marks every unread notification of the caller as read, up to the position {@code before} (inclusive) when
     * given: notifications that arrived after the list was loaded stay unread. Without {@code before} it marks
     * everything, the fallback when the loaded list was empty.
     *
     * @param before the {@link NotificationPage#headCursor()} of the loaded page; null or empty means no bound
     * @throws ApiException 401, 403 {@code USER_SUSPENDED}; 400 {@code VALIDATION_ERROR} when the cursor is malformed
     */
    @Transactional
    public UnreadCountResponse markAllRead(String before) {
        UUID me = currentUserService.requireActive();
        NotificationCursor upTo = NotificationCursor.decode(before);
        if (upTo == null) {
            notificationRepository.markAllRead(me);
        } else {
            notificationRepository.markAllReadUpTo(me, upTo.createdAt(), upTo.id());
        }
        return unreadCount(me);
    }

    /**
     * Permanently deletes one of the caller's notifications. Deleting a like notification and then having the other
     * user like again is the only way to get a new like notification, and that time it is subject to the like rate
     * limit.
     *
     * @throws ApiException 401, 403 {@code USER_SUSPENDED}; 404 {@code NOTIFICATION_NOT_FOUND} when missing
     *                      (including a second delete), or someone else's
     */
    @Transactional
    public UnreadCountResponse delete(UUID id) {
        UUID me = currentUserService.requireActive();
        if (notificationRepository.deleteOwn(id, me) == 0) {
            throw notFound(id);
        }
        return unreadCount(me);
    }

    private UnreadCountResponse unreadCount(UUID me) {
        return new UnreadCountResponse(notificationRepository.countUnread(me));
    }

    private static NotificationResponse toResponse(NotificationRow row) {
        String content = row.getCommentContent();
        return new NotificationResponse(
                row.getId(),
                row.getType(),
                row.getCreatedAt(),
                row.getRead(),
                new NotificationActorResponse(
                        row.getActorDisplayName(), row.getActorGithubLogin(), row.getActorAvatarUrl()),
                new NotificationPostResponse(row.getPostSlug(), row.getPostTitle()),
                row.getCommentId(),
                content == null ? null : NotificationExcerpt.of(content));
    }

    private static ApiException notFound(UUID id) {
        return new ApiException(
                ErrorCode.NOTIFICATION_NOT_FOUND, HttpStatus.NOT_FOUND, "Notification not found: " + id);
    }
}
