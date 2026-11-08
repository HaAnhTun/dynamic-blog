package com.blog.newsletter.service;

import com.blog.newsletter.repository.NewsletterRepository;
import java.time.Clock;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * The newsletter outbox: PostService.publish calls it exactly once, when a post gets its first {@code publishedAt}. It
 * writes only one row, inside the publish transaction (MANDATORY): it sends nothing, so a mail provider outage cannot
 * break publishing a post. An existing row is skipped (ON CONFLICT).
 *
 * <p>The mail goes to every confirmed subscriber of the post language, with text the publisher wrote, so only an ADMIN
 * queues it directly. A post published by anyone else (an AUTHOR) is recorded as HELD: the worker does not split it into
 * mails until an ADMIN releases it, and an ADMIN can discard it ({@link NewsletterService#release}).
 */
@Component
@RequiredArgsConstructor
public class NewsletterOutbox {

    private final NewsletterRepository repository;
    private final Clock clock;

    /**
     * @param byAdmin whether the person who published the post is an ADMIN: the issue is queued; otherwise it is held
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public void firstPublished(UUID postId, boolean byAdmin) {
        repository.insertIssue(postId, !byAdmin, clock.instant());
    }
}
