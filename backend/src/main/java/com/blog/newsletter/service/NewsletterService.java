package com.blog.newsletter.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.Languages;
import com.blog.common.ratelimit.ClientAddress;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.newsletter.dto.NewsletterHeldIssueResponse;
import com.blog.newsletter.dto.NewsletterStatsResponse;
import com.blog.newsletter.repository.NewsletterRepository;
import com.blog.newsletter.repository.NewsletterRepository.HeldIssue;
import com.blog.newsletter.repository.NewsletterRepository.PendingToken;
import com.blog.newsletter.repository.NewsletterRepository.Subscriber;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Newsletter subscribe, confirm and unsubscribe, and the figures for the admin. No call here sends a mail or creates a
 * confirmation token: that is the job of NewsletterWorker, so the response time of a signup does not depend on the state
 * of the address. Every error message is generic and never echoes an address or a token.
 */
@Service
@RequiredArgsConstructor
public class NewsletterService {

    private static final Logger log = LoggerFactory.getLogger(NewsletterService.class);

    private static final int LATEST_ISSUES = 10;
    private static final int HELD_LIMIT = 100;

    private final NewsletterRepository repository;
    private final NewsletterTokens tokens;
    private final RateLimiter rateLimiter;
    private final Languages languages;
    private final Clock clock;

    /**
     * Every well-formed address gets the same result. Over a rate limit, nothing happens; already
     * confirmed, nothing changes; pending, a new confirmation mail is queued (the new token replaces the old one); not
     * present, even one that unsubscribed before, a pending subscription is added: the suppression row goes away only
     * when the address is confirmed again. The locale (absent means the default) is stored with a new or pending
     * subscription and decides the language of its mails; a confirmed subscriber keeps theirs.
     *
     * Three limits, none of them visible to the caller (over any of them the answer is the same as for a queued
     * signup, so nobody can probe addresses or learn which limit tripped): the client address (rotating the submitted
     * address does not help), the submitted address, then the whole site, which is counted last so that only
     * signups that would really queue a mail use it up.
     *
     * @param client where the request comes from
     * @throws ApiException 400 {@code VALIDATION_ERROR} when it is not a usable address or the locale is not enabled
     */
    @Transactional
    public void subscribe(String rawEmail, String rawLocale, ClientAddress client) {
        String email = EmailAddresses.normalize(rawEmail)
                .orElseThrow(() ->
                        new ApiException(ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "Invalid email address"));
        String locale = languages.orDefault(rawLocale);
        if (rateLimiter.allow(RateLimiter.NEWSLETTER_SIGNUP_CLIENT, client.key())
                && rateLimiter.allow(RateLimiter.NEWSLETTER_SIGNUP, email)
                && rateLimiter.allow(RateLimiter.NEWSLETTER_SIGNUP_GLOBAL, RateLimiter.GLOBAL_KEY)) {
            repository.requestConfirmation(email, locale, clock.instant());
        }
    }

    /**
     * An unexpired token of a pending subscription: confirms, drops the token, drops the suppression row of the address.
     * The client address and the whole site (confirmations only) are counted first, for every call, so guessing tokens
     * costs quota. The per-subscriber-address rate limit is counted after the lookup succeeds, so a stray token cannot get
     * anyone blocked.
     *
     * @param client where the request comes from
     * @throws ApiException 400 {@code NEWSLETTER_TOKEN_INVALID} when the token is malformed, unknown, expired or used;
     *                      429 {@code RATE_LIMITED}
     */
    @Transactional
    public void confirm(String token, ClientAddress client) {
        limitClient(client);
        rateLimiter.check(RateLimiter.NEWSLETTER_CONFIRM_GLOBAL, RateLimiter.GLOBAL_KEY);
        if (!NewsletterTokens.wellFormed(token)) {
            throw invalidToken();
        }
        PendingToken pending = repository
                .lockPendingByTokenHash(NewsletterTokens.sha256Hex(token))
                .orElseThrow(NewsletterService::invalidToken);
        rateLimiter.check(RateLimiter.NEWSLETTER_TOKEN, pending.email());
        Instant now = clock.instant();
        if (!pending.expiresAt().isAfter(now)) {
            throw invalidToken();
        }
        repository.confirm(pending.id(), now);
        repository.unsuppress(tokens.suppressionHash(pending.email()));
    }

    /**
     * A valid MAC is enough: no login needed, valid indefinitely. If the subscription still exists, writes the suppression
     * row then deletes the address outright; if already unsubscribed, it still succeeds.
     *
     * Only the client address is counted before the token is checked, and the subscriber's own address after the lookup. There
     * is deliberately NO whole-site ceiling on unsubscribing: a ceiling would let anyone use it up with stray tokens (from a few
     * dozen addresses) and leave every real unsubscribe, one-click mail-provider requests included, with a 429, which
     * must never happen. The check itself costs one MAC comparison and, for a valid token, one idempotent lookup.
     *
     * @param client where the request comes from (counted per address like in {@link #confirm})
     * @throws ApiException 400 {@code NEWSLETTER_TOKEN_INVALID} when the token is malformed or the MAC is wrong; 429 {@code RATE_LIMITED}
     */
    @Transactional
    public void unsubscribe(String token, ClientAddress client) {
        limitClient(client);
        UUID id = tokens.unsubscribeId(token).orElseThrow(NewsletterService::invalidToken);
        Optional<Subscriber> subscriber = repository.lockSubscriber(id);
        if (subscriber.isEmpty()) {
            return;
        }
        rateLimiter.check(RateLimiter.NEWSLETTER_TOKEN, subscriber.get().email());
        repository.suppress(tokens.suppressionHash(subscriber.get().email()), clock.instant());
        repository.deleteSubscriber(id);
    }

    /** The newsletters that wait for an administrator, oldest first (at most {@value #HELD_LIMIT}). */
    @Transactional(readOnly = true)
    public List<NewsletterHeldIssueResponse> held() {
        return repository.heldIssues(HELD_LIMIT).stream()
                .map(held -> new NewsletterHeldIssueResponse(
                        held.postId(),
                        held.slug(),
                        NewsletterComposer.mailTitle(held.title()),
                        NewsletterComposer.mailExcerpt(held.excerpt()),
                        held.language(),
                        held.authorName(),
                        held.heldAt(),
                        held.published(),
                        held.recipients(),
                        reviewVersion(held)))
                .toList();
    }

    /**
     * Stands for the text of a held issue as the list shows it: the address, the one-line subject, the cut excerpt and the
     * language. Each part carries its length (an absent excerpt is a dash), so two different texts never give the same input.
     * The administrator sends it back with the release, which recomputes it from the post as it is then.
     */
    static String reviewVersion(HeldIssue held) {
        StringBuilder text = new StringBuilder("held-issue-v1");
        for (String part : new String[] {
            held.slug(),
            NewsletterComposer.mailTitle(held.title()),
            NewsletterComposer.mailExcerpt(held.excerpt()),
            held.language()
        }) {
            text.append('|').append(part == null ? "-" : part.length() + ":" + part);
        }
        return NewsletterTokens.sha256Hex(text.toString());
    }

    /**
     * Lets a held newsletter go: it becomes PENDING and the worker mails it to the confirmed subscribers of the post language,
     * with the subject, the excerpt and the language as they are now (stored with the issue: a later edit of the post does not
     * change the mail or its audience). Only text the administrator read can go: {@code version} is the one the held list
     * returned, and it is compared with the post under the lock of the issue, so an edit made after the list was loaded (an
     * author can save again and again) is not mailed unseen. A held issue of a post that is not published waits until the post
     * is published again.
     *
     * @param version the {@code version} of the held list that the administrator read
     * @param adminId the administrator who decides, from the token
     * @throws ApiException 404 {@code NEWSLETTER_ISSUE_NOT_FOUND} when the issue is not held (decided already, or no such post);
     *                      409 {@code NEWSLETTER_ISSUE_CHANGED} when the post is not what the version stands for
     */
    @Transactional
    public void release(UUID postId, String version, UUID adminId) {
        HeldIssue held = repository.lockHeldIssue(postId).orElseThrow(NewsletterService::notHeld);
        if (!reviewVersion(held).equals(version)) {
            throw new ApiException(
                    ErrorCode.NEWSLETTER_ISSUE_CHANGED,
                    HttpStatus.CONFLICT,
                    "The post changed since the list was loaded; nothing was released");
        }
        repository.release(
                postId,
                adminId,
                NewsletterComposer.mailTitle(held.title()),
                NewsletterComposer.mailExcerpt(held.excerpt()),
                held.language(),
                clock.instant());
        log.info("newsletter issue released postId={} by={}", postId, adminId);
    }

    /**
     * Refuses a held newsletter: it is kept as DISCARDED and never mailed. The post itself is untouched.
     *
     * @param adminId the administrator who decides, from the token
     * @throws ApiException 404 {@code NEWSLETTER_ISSUE_NOT_FOUND} when the issue is not held
     */
    @Transactional
    public void discard(UUID postId, UUID adminId) {
        repository.lockHeldIssue(postId).orElseThrow(NewsletterService::notHeld);
        repository.discard(postId, adminId, clock.instant());
        log.info("newsletter issue discarded postId={} by={}", postId, adminId);
    }

    @Transactional(readOnly = true)
    public NewsletterStatsResponse stats() {
        return new NewsletterStatsResponse(
                repository.subscriberCounts(),
                repository.suppressedCount(),
                repository.latestIssues(LATEST_ISSUES),
                repository.failures());
    }

    /** Confirmations and unsubscribes share the count of one client address; only confirmations also use the whole-site one. */
    private void limitClient(ClientAddress client) {
        rateLimiter.check(RateLimiter.NEWSLETTER_TOKEN_CLIENT, client.key());
    }

    private static ApiException notHeld() {
        return new ApiException(
                ErrorCode.NEWSLETTER_ISSUE_NOT_FOUND, HttpStatus.NOT_FOUND, "No held newsletter for this post");
    }

    private static ApiException invalidToken() {
        return new ApiException(
                ErrorCode.NEWSLETTER_TOKEN_INVALID, HttpStatus.BAD_REQUEST, "The link is invalid or has expired");
    }
}
