package com.blog.author.dto;

import com.blog.author.entity.AuthorApplication;
import java.time.Instant;
import java.util.UUID;

/**
 * An application as the applicant sees it: without the deciding user.
 *
 * @param status     {@code PENDING}, {@code APPROVED} or {@code REJECTED}
 * @param motivation null when the applicant wrote nothing
 * @param decidedAt  null while the application is still pending
 */
public record AuthorApplicationResponse(
        UUID id, String status, String motivation, Instant createdAt, Instant decidedAt) {

    public static AuthorApplicationResponse from(AuthorApplication application) {
        return new AuthorApplicationResponse(
                application.getId(),
                application.getStatus().name(),
                application.getMotivation(),
                application.getCreatedAt(),
                application.getDecidedAt());
    }
}
