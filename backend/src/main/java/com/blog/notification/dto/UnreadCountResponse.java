package com.blog.notification.dto;

/**
 * The number of unread notifications the caller can still see, after the read or write that just finished.
 *
 * @param count from 0 to 100: capped at 100, the bell only shows "99+"
 */
public record UnreadCountResponse(long count) {}
