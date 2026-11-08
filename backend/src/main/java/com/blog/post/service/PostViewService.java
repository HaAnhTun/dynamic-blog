package com.blog.post.service;

import static java.nio.charset.StandardCharsets.UTF_8;

import com.blog.analytics.config.AnalyticsProperties;
import com.blog.analytics.service.ViewSourceClassifier;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.post.config.ViewsProperties;
import com.blog.post.repository.PostViewRepository;
import java.security.MessageDigest;
import java.time.Clock;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The view counter: the only write in the whole API that needs no login, and it can do exactly one thing: add one to
 * the counter of a PUBLISHED post, together with that post's per-day and per-source-group counts.
 *
 * The count is approximate, for decoration: the Next server filters bots and counts once per session before forwarding
 * here. Nothing important relies on it, so nothing is stored here to prevent repeat counting (IP, user agent): only an
 * optional shared token ({@link ViewsProperties}) for when the backend has a public URL.
 */
@Service
public class PostViewService {

    private final PostViewRepository postViewRepository;
    /** The configured token as bytes for comparison; null when not set (anyone can count). */
    private final byte[] token;

    private final ViewSourceClassifier sources;
    private final AnalyticsProperties analytics;
    private final Clock clock;

    public PostViewService(
            PostViewRepository postViewRepository,
            ViewsProperties properties,
            ViewSourceClassifier sources,
            AnalyticsProperties analytics,
            Clock clock) {
        this.postViewRepository = postViewRepository;
        this.token = properties.tokenRequired() ? properties.token().getBytes(UTF_8) : null;
        this.sources = sources;
        this.analytics = analytics;
        this.clock = clock;
    }

    /**
     * Adds one view to the published post with this slug: to the total, then to its (day in the analytics time zone,
     * source group) row, in the same transaction.
     *
     * The token is checked before touching the DB: without the token nothing can be counted, and the 404 answer cannot
     * be used to probe which slugs are real posts.
     *
     * @param tokenHeader  value of the {@code X-View-Token} header, null when not sent
     * @param referrerHost value of the {@code X-View-Referrer} header, null when not sent; only its group is recorded
     * @throws ApiException 403 {@code FORBIDDEN} when a token is set and the header is missing or wrong; 404
     *                      {@code POST_NOT_FOUND} when no published post has that slug
     */
    @Transactional
    public void record(String slug, String tokenHeader, String referrerHost) {
        if (token != null && !matchesToken(tokenHeader)) {
            throw new ApiException(ErrorCode.FORBIDDEN, HttpStatus.FORBIDDEN, "Missing or invalid X-View-Token header");
        }
        if (postViewRepository.incrementBySlug(slug) == 0) {
            throw new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + slug);
        }
        postViewRepository.incrementDailyBySlug(
                slug, analytics.today(clock), sources.classify(referrerHost).value());
    }

    /**
     * Constant-time comparison: {@code String.equals} stops at the first wrong character, so timing the answers of a
     * public endpoint would reveal the token one character at a time. {@link MessageDigest#isEqual} walks the full length
     * of its first argument wherever it differs; the configured token is the one standing there, so the time depends only
     * on its length, not on what the caller sends.
     */
    private boolean matchesToken(String tokenHeader) {
        return tokenHeader != null && MessageDigest.isEqual(token, tokenHeader.getBytes(UTF_8));
    }
}
