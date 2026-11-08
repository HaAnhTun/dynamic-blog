package com.blog.author.dto;

import com.blog.author.entity.AuthorApplication;
import java.time.Instant;
import java.util.UUID;

/** An application as the admin sees it: like {@link AuthorApplicationResponse}, plus the applicant. Call inside a transaction (applicant is LAZY). */
public record AuthorApplicationAdminResponse(
        UUID id,
        String status,
        String motivation,
        Instant createdAt,
        Instant decidedAt,
        AuthorApplicantResponse applicant) {

    public static AuthorApplicationAdminResponse from(AuthorApplication application) {
        return new AuthorApplicationAdminResponse(
                application.getId(),
                application.getStatus().name(),
                application.getMotivation(),
                application.getCreatedAt(),
                application.getDecidedAt(),
                AuthorApplicantResponse.from(application.getUser()));
    }
}
