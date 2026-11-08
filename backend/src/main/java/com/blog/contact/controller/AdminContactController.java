package com.blog.contact.controller;

import com.blog.common.response.ApiResponse;
import com.blog.common.response.PageMeta;
import com.blog.common.response.PagedResponse;
import com.blog.contact.dto.ContactMessageResponse;
import com.blog.contact.dto.ContactUnreadCountResponse;
import com.blog.contact.service.ContactInboxService;
import com.blog.contact.service.ContactInboxService.Page;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * The contact inbox. ADMIN only, enforced by the URL rule {@code /api/v1/admin/contact/**} in SecurityConfig: the
 * messages are the site owner's mail, never an AUTHOR's.
 */
@RestController
@RequestMapping("/api/v1/admin/contact")
@RequiredArgsConstructor
public class AdminContactController {

    private final ContactInboxService inbox;

    /** Newest first; {@code size} is clamped to 1..100. */
    @GetMapping("/messages")
    public PagedResponse<ContactMessageResponse> list(
            @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "20") int size) {
        Page result = inbox.list(page, size);
        return new PagedResponse<>(
                result.items(),
                new PageMeta(result.page(), result.size(), result.totalElements(), result.totalPages()));
    }

    /** The number of unread messages over the whole inbox, for the badge in the admin navigation. */
    @GetMapping("/unread-count")
    public ApiResponse<ContactUnreadCountResponse> unreadCount() {
        return ApiResponse.of(inbox.unreadCount());
    }

    /** Idempotent, 204 with no body; an unknown id is 404. */
    @PostMapping("/messages/{id}/read")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void markRead(@PathVariable UUID id) {
        inbox.markRead(id);
    }

    /** 204 with no body; an unknown id is 404. */
    @DeleteMapping("/messages/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID id) {
        inbox.delete(id);
    }
}
