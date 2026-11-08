package com.blog.newsletter.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Newsletter figures for the admin ({@code GET /api/v1/admin/newsletter}). Numbers only, never an address.
 *
 * @param suppressed number of suppression rows: addresses that unsubscribed, kept only as a hash
 * @param issues     at most the 10 most recent sends, newest first
 * @param failures   mails being retried or given up on, by safe error code, most frequent first
 */
public record NewsletterStatsResponse(
        NewsletterSubscriberCounts subscribers,
        long suppressed,
        List<NewsletterIssueStats> issues,
        List<NewsletterFailureCount> failures) {

    public record NewsletterSubscriberCounts(long pending, long confirmed) {}

    /**
     * Status of the send itself: PENDING is not yet split into mails, EXPANDED is already split, HELD waits for an
     * administrator (a post published by an AUTHOR), DISCARDED was refused by one and is never sent.
     */
    public enum IssueStatus {
        PENDING,
        EXPANDED,
        HELD,
        DISCARDED
    }

    /** A post published for the first time, and the number of its mails by delivery status. */
    public record NewsletterIssueStats(
            UUID postId,
            String slug,
            String title,
            Instant createdAt,
            IssueStatus status,
            long sent,
            long retrying,
            long dead,
            long pending) {}

    /** @param reason a safe code: CONNECTION_FAILED, TIMEOUT, AUTH_FAILED, REJECTED, INVALID_ADDRESS, UNKNOWN, SUPPRESSED */
    public record NewsletterFailureCount(String reason, long count) {}
}
