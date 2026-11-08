package com.blog.notification.controller;

import com.blog.common.response.ApiResponse;
import com.blog.notification.dto.NotificationPage;
import com.blog.notification.dto.UnreadCountResponse;
import com.blog.notification.service.NotificationService;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * The notification inbox of the signed-in user. Every route needs login, any role (per-method rules in
 * SecurityConfig), and only touches the token owner's notifications: no route accepts a user id. No route accepts
 * a body.
 *
 * Every write returns the new unread count, so the bell updates without asking again.
 */
@RestController
@RequestMapping("/api/v1/notifications")
@RequiredArgsConstructor
public class NotificationController {

    private final NotificationService notificationService;

    /** One page of notifications, newest first; {@code unread=true} returns only unread notifications. */
    @GetMapping
    public ApiResponse<NotificationPage> list(
            @RequestParam(required = false) String after,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(defaultValue = "false") boolean unread) {
        return ApiResponse.of(notificationService.list(after, size, unread));
    }

    @GetMapping("/unread-count")
    public ApiResponse<UnreadCountResponse> unreadCount() {
        return ApiResponse.of(notificationService.unreadCount());
    }

    /** Marks one notification as read; idempotent. */
    @PostMapping("/{id}/read")
    public ApiResponse<UnreadCountResponse> markRead(@PathVariable UUID id) {
        return ApiResponse.of(notificationService.markRead(id));
    }

    /** Marks every notification up to {@code before} (the headCursor of the loaded page) as read, or all of them when absent. */
    @PostMapping("/read-all")
    public ApiResponse<UnreadCountResponse> markAllRead(@RequestParam(required = false) String before) {
        return ApiResponse.of(notificationService.markAllRead(before));
    }

    /** Deletes one notification; 200 with the unread count, not 204. */
    @DeleteMapping("/{id}")
    public ApiResponse<UnreadCountResponse> delete(@PathVariable UUID id) {
        return ApiResponse.of(notificationService.delete(id));
    }
}
