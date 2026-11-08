package com.blog.author.dto;

import jakarta.validation.constraints.Size;

/**
 * The optional body of POST /api/v1/admin/author-applications/{id}/approve.
 *
 * @param code the acting administrator's own code (an authenticator code or a recovery code), needed when the approval makes a
 *             reader an author (RoleChangeStepUp); ignored when the applicant already has the role. {@link #toString()} is redacted.
 */
public record AuthorApplicationApproveRequest(
        @Size(max = 64) String code) {

    @Override
    public String toString() {
        return "AuthorApplicationApproveRequest[redacted]";
    }
}
