package com.blog.contact.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.contact.dto.ContactMessageResponse;
import com.blog.contact.dto.ContactUnreadCountResponse;
import com.blog.contact.repository.ContactMessageRepository;
import java.time.Clock;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/** The admin inbox of the contact form: list, mark read, delete. Callers are ADMIN only (SecurityConfig). */
@Service
@RequiredArgsConstructor
public class ContactInboxService {

    static final int MAX_PAGE_SIZE = 100;
    /** The largest page whose start offset (page x size) still fits an int. */
    private static final int MAX_PAGE = Integer.MAX_VALUE / MAX_PAGE_SIZE;

    private final ContactMessageRepository repository;
    private final Clock clock;

    /** A page of messages, newest first, with the total count. */
    public record Page(List<ContactMessageResponse> items, int page, int size, long totalElements) {
        public int totalPages() {
            return (int) ((totalElements + size - 1) / size);
        }
    }

    /**
     * @param page clamped to 0 and up
     * @param size clamped to 1..100
     */
    public Page list(int page, int size) {
        int safePage = Math.clamp(page, 0, MAX_PAGE);
        int safeSize = Math.clamp(size, 1, MAX_PAGE_SIZE);
        return new Page(repository.list(safeSize, (long) safePage * safeSize), safePage, safeSize, repository.count());
    }

    public ContactUnreadCountResponse unreadCount() {
        return new ContactUnreadCountResponse(repository.unreadCount());
    }

    /**
     * Idempotent: reading again keeps the first read time.
     *
     * @throws ApiException 404 {@code CONTACT_MESSAGE_NOT_FOUND}
     */
    public void markRead(UUID id) {
        if (!repository.markRead(id, clock.instant())) {
            throw notFound();
        }
    }

    /** @throws ApiException 404 {@code CONTACT_MESSAGE_NOT_FOUND} */
    public void delete(UUID id) {
        if (!repository.delete(id)) {
            throw notFound();
        }
    }

    private static ApiException notFound() {
        return new ApiException(ErrorCode.CONTACT_MESSAGE_NOT_FOUND, HttpStatus.NOT_FOUND, "Message not found");
    }
}
