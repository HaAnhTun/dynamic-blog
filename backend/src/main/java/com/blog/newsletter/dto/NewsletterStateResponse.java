package com.blog.newsletter.dto;

/** Response of subscribe, confirm and unsubscribe: just one status, identical every time for the same outcome. */
public record NewsletterStateResponse(NewsletterState status) {

    public enum NewsletterState {
        PENDING_CONFIRMATION,
        CONFIRMED,
        UNSUBSCRIBED
    }

    public static final NewsletterStateResponse PENDING_CONFIRMATION =
            new NewsletterStateResponse(NewsletterState.PENDING_CONFIRMATION);
    public static final NewsletterStateResponse CONFIRMED = new NewsletterStateResponse(NewsletterState.CONFIRMED);
    public static final NewsletterStateResponse UNSUBSCRIBED =
            new NewsletterStateResponse(NewsletterState.UNSUBSCRIBED);
}
