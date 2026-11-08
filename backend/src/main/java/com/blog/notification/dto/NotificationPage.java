package com.blog.notification.dto;

import java.util.List;

/**
 * One page of notifications, newest first.
 *
 * @param nextCursor value for {@code ?after=} of the next page; null on the last page. It is the position
 *                   (timestamp, id) of the last notification on the page, so a notification arriving between two
 *                   loads cannot make the next page repeat or skip anything
 * @param headCursor position of the newest notification on this page, present only on the first page (no
 *                   {@code after}) and when the page is not empty; null in every other case. Sent back as the
 *                   {@code before} of "mark all as read": notifications that arrived after the page was loaded stay
 *                   unread
 */
public record NotificationPage(List<NotificationResponse> items, String nextCursor, String headCursor) {}
