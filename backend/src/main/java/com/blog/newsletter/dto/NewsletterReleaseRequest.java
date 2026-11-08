package com.blog.newsletter.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * {@code {"version": "..."}} of {@code POST /api/v1/admin/newsletter/issues/{postId}/release}: the {@code version} of the
 * held issue as {@code GET /api/v1/admin/newsletter/held} returned it, which stands for the text the administrator read (the
 * subject, the excerpt, the language and the address). A release for a post that changed since answers 409
 * {@code NEWSLETTER_ISSUE_CHANGED}.
 */
public record NewsletterReleaseRequest(
        @NotBlank @Size(max = 128) String version) {}
