package com.blog.common.ratelimit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

/**
 * Per-user rate limiting: a sliding window over the moments the attempts were accepted, one
 * ledger per person, one limiter per kind of action.
 *
 * The clock is a nanosecond counter pushed forward by hand: the window boundary is checked right at the edge, without waiting in real time.
 */
class RateLimiterTest {

    /**
     * The default values: comments 5/minute and 30/hour, edit and delete 20 per 10 minutes, like 30/minute; login does not
     * go through RateLimiter.
     */
    private static final RateLimitProperties DEFAULTS = new RateLimitProperties(
            new RateLimitProperties.Comment(5, 30),
            new RateLimitProperties.CommentEdit(20),
            new RateLimitProperties.Like(30),
            new RateLimitProperties.Login(2, Duration.ofSeconds(5)),
            new RateLimitProperties.RoleChange(20),
            new RateLimitProperties.AuthorApplication(5),
            new RateLimitProperties.Bookmark(30),
            new RateLimitProperties.NewsletterSignup(3),
            new RateLimitProperties.NewsletterToken(20),
            new RateLimitProperties.Search(1200),
            new RateLimitProperties.SearchReindex(3),
            new RateLimitProperties.Setup(10),
            new RateLimitProperties.SiteContentWrite(60),
            new RateLimitProperties.PostImportWrite(60),
            new RateLimitProperties.ArticlePreview(300),
            new RateLimitProperties.MfaStepUp(10),
            new RateLimitProperties.PasswordChange(5),
            new RateLimitProperties.ContactClient(5),
            new RateLimitProperties.ContactGlobal(60),
            new RateLimitProperties.NewsletterSignupClient(5),
            new RateLimitProperties.NewsletterSignupGlobal(120),
            new RateLimitProperties.NewsletterTokenClient(40),
            new RateLimitProperties.NewsletterConfirmGlobal(300),
            new RateLimitProperties.LoginClient(20),
            new RateLimitProperties.MfaClient(20),
            new RateLimitProperties.RefreshClient(60),
            new RateLimitProperties.SetupClient(5),
            new RateLimitProperties.SearchClient(120),
            new RateLimitProperties.PostWrite(60),
            new RateLimitProperties.TaxonomyCreate(10),
            new RateLimitProperties.MediaUpload(30));

    private final AtomicLong nanos = new AtomicLong(1_000_000_000L);

    private RateLimiter limiter(int maxKeys) {
        return new RateLimiter(DEFAULTS, nanos::get, maxKeys);
    }

    private void advance(Duration duration) {
        nanos.addAndGet(duration.toNanos());
    }

    private static boolean allowed(RateLimiter limiter, String bucket, UUID user) {
        try {
            limiter.check(bucket, user);
            return true;
        } catch (ApiException e) {
            assertThat(e.getCode()).isEqualTo(ErrorCode.RATE_LIMITED);
            assertThat(e.getStatus()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
            return false;
        }
    }

    private static int allowedCount(RateLimiter limiter, String bucket, UUID user, int attempts) {
        int allowed = 0;
        for (int i = 0; i < attempts; i++) {
            allowed += allowed(limiter, bucket, user) ? 1 : 0;
        }
        return allowed;
    }

    @Test
    void sixth_comment_within_a_minute_gets_429_RATE_LIMITED_with_no_who_or_what() {
        RateLimiter limiter = limiter(100);
        UUID user = UUID.randomUUID();

        for (int i = 0; i < 5; i++) {
            limiter.check(RateLimiter.COMMENT, user);
        }
        assertThatThrownBy(() -> limiter.check(RateLimiter.COMMENT, user))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.RATE_LIMITED);
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
                    assertThat(e.getMessage()).doesNotContain(user.toString());
                });
    }

    @Test
    void sliding_window_oldest_attempt_leaves_exactly_when_a_full_minute_has_passed() {
        RateLimiter limiter = limiter(100);
        UUID user = UUID.randomUUID();
        assertThat(allowedCount(limiter, RateLimiter.COMMENT, user, 5)).isEqualTo(5);

        // Right at the boundary: the first attempt is still 1 ns short of a full minute, so it still counts.
        advance(Duration.ofMinutes(1).minusNanos(1));
        assertThat(allowed(limiter, RateLimiter.COMMENT, user)).isFalse();

        advance(Duration.ofNanos(1));
        assertThat(allowed(limiter, RateLimiter.COMMENT, user)).isTrue();
        // The other four are at the same moment as the first so they also just left the window; the newly accepted one
        // takes a slot.
        assertThat(allowedCount(limiter, RateLimiter.COMMENT, user, 10)).isEqualTo(4);
    }

    @Test
    void rejected_attempt_is_not_recorded_so_hammering_does_not_extend_the_block() {
        RateLimiter limiter = limiter(100);
        UUID user = UUID.randomUUID();
        assertThat(allowedCount(limiter, RateLimiter.COMMENT, user, 5)).isEqualTo(5);

        for (int second = 1; second < 60; second++) {
            advance(Duration.ofSeconds(1));
            assertThat(allowed(limiter, RateLimiter.COMMENT, user)).isFalse();
        }

        advance(Duration.ofSeconds(1));
        assertThat(allowed(limiter, RateLimiter.COMMENT, user)).isTrue();
    }

    @Test
    void comments_still_limited_to_30_per_hour_even_if_every_minute_is_under_5() {
        RateLimiter limiter = limiter(100);
        UUID user = UUID.randomUUID();

        // 30 attempts in 6 minutes, 5 per minute: none hits the minute limit.
        for (int minute = 0; minute < 6; minute++) {
            assertThat(allowedCount(limiter, RateLimiter.COMMENT, user, 5))
                    .as("minute %d", minute)
                    .isEqualTo(5);
            advance(Duration.ofMinutes(1));
        }
        assertThat(allowed(limiter, RateLimiter.COMMENT, user))
                .as("31st attempt within one hour")
                .isFalse();

        // An hour after the first burst, the 5 attempts of the first minute leave the hour window.
        advance(Duration.ofMinutes(54));
        assertThat(allowedCount(limiter, RateLimiter.COMMENT, user, 10)).isEqualTo(5);
    }

    @Test
    void each_person_has_own_ledger() {
        RateLimiter limiter = limiter(100);
        UUID spammer = UUID.randomUUID();
        UUID other = UUID.randomUUID();
        assertThat(allowedCount(limiter, RateLimiter.COMMENT, spammer, 10)).isEqualTo(5);

        assertThat(allowedCount(limiter, RateLimiter.COMMENT, other, 5)).isEqualTo(5);
    }

    @Test
    void each_kind_of_action_has_its_own_limit() {
        RateLimiter limiter = limiter(100);
        UUID user = UUID.randomUUID();
        assertThat(allowedCount(limiter, RateLimiter.COMMENT, user, 10)).isEqualTo(5);

        // Running out of comment quota does not block edit, delete or like of the same person.
        assertThat(allowedCount(limiter, RateLimiter.COMMENT_EDIT, user, 25)).isEqualTo(20);
        assertThat(allowedCount(limiter, RateLimiter.LIKE, user, 40)).isEqualTo(30);

        advance(Duration.ofMinutes(10).minusNanos(1));
        assertThat(allowed(limiter, RateLimiter.COMMENT_EDIT, user)).isFalse();
        advance(Duration.ofNanos(1));
        assertThat(allowed(limiter, RateLimiter.COMMENT_EDIT, user)).isTrue();
    }

    @Test
    void the_post_import_bucket_is_separate_from_the_site_content_bucket_and_allows_60_per_ten_minutes() {
        RateLimiter limiter = limiter(100);
        UUID user = UUID.randomUUID();
        assertThat(allowedCount(limiter, RateLimiter.SITE_CONTENT_WRITE, user, 70))
                .isEqualTo(60);

        // Running out of site content quota leaves the post import quota of the same person untouched.
        assertThat(allowedCount(limiter, RateLimiter.POST_IMPORT_WRITE, user, 70))
                .isEqualTo(60);

        advance(Duration.ofMinutes(10).minusNanos(1));
        assertThat(allowed(limiter, RateLimiter.POST_IMPORT_WRITE, user)).isFalse();
        advance(Duration.ofNanos(1));
        assertThat(allowed(limiter, RateLimiter.POST_IMPORT_WRITE, user)).isTrue();
    }

    @Test
    void the_article_preview_bucket_is_apart_from_the_post_import_bucket_and_allows_300_per_ten_minutes() {
        RateLimiter limiter = limiter(100);
        UUID user = UUID.randomUUID();
        assertThat(allowedCount(limiter, RateLimiter.ARTICLE_PREVIEW, user, 310))
                .isEqualTo(300);

        // Previewing many files leaves the previews, applies and undos of the same person untouched.
        assertThat(allowedCount(limiter, RateLimiter.POST_IMPORT_WRITE, user, 70))
                .isEqualTo(60);
        assertThat(allowedCount(limiter, RateLimiter.ARTICLE_PREVIEW, user, 1)).isZero();

        advance(Duration.ofMinutes(10).minusNanos(1));
        assertThat(allowed(limiter, RateLimiter.ARTICLE_PREVIEW, user)).isFalse();
        advance(Duration.ofNanos(1));
        assertThat(allowed(limiter, RateLimiter.ARTICLE_PREVIEW, user)).isTrue();
    }

    @Test
    void the_step_ups_of_two_step_verification_and_the_password_change_have_their_own_windows_of_ten_minutes() {
        RateLimiter limiter = limiter(100);
        UUID user = UUID.randomUUID();

        assertThat(allowedCount(limiter, RateLimiter.MFA_STEP_UP, user, 20)).isEqualTo(10);
        assertThat(allowedCount(limiter, RateLimiter.PASSWORD_CHANGE, user, 20)).isEqualTo(5);
        // Per person, and per kind of operation: one person's limit is not another's, and a full bucket is not the
        // other.
        assertThat(allowed(limiter, RateLimiter.MFA_STEP_UP, UUID.randomUUID())).isTrue();
        advance(Duration.ofMinutes(10));
        assertThat(allowed(limiter, RateLimiter.MFA_STEP_UP, user)).isTrue();
        assertThat(allowed(limiter, RateLimiter.PASSWORD_CHANGE, user)).isTrue();
    }

    @Test
    void limits_come_from_configuration() {
        RateLimitProperties tight = new RateLimitProperties(
                new RateLimitProperties.Comment(2, 3),
                new RateLimitProperties.CommentEdit(1),
                new RateLimitProperties.Like(1),
                new RateLimitProperties.Login(1, Duration.ofSeconds(1)),
                new RateLimitProperties.RoleChange(2),
                new RateLimitProperties.AuthorApplication(1),
                new RateLimitProperties.Bookmark(3),
                new RateLimitProperties.NewsletterSignup(2),
                new RateLimitProperties.NewsletterToken(4),
                new RateLimitProperties.Search(6),
                new RateLimitProperties.SearchReindex(2),
                new RateLimitProperties.Setup(3),
                new RateLimitProperties.SiteContentWrite(2),
                new RateLimitProperties.PostImportWrite(3),
                new RateLimitProperties.ArticlePreview(4),
                new RateLimitProperties.MfaStepUp(2),
                new RateLimitProperties.PasswordChange(3),
                new RateLimitProperties.ContactClient(2),
                new RateLimitProperties.ContactGlobal(3),
                new RateLimitProperties.NewsletterSignupClient(2),
                new RateLimitProperties.NewsletterSignupGlobal(3),
                new RateLimitProperties.NewsletterTokenClient(2),
                new RateLimitProperties.NewsletterConfirmGlobal(3),
                new RateLimitProperties.LoginClient(2),
                new RateLimitProperties.MfaClient(2),
                new RateLimitProperties.RefreshClient(3),
                new RateLimitProperties.SetupClient(2),
                new RateLimitProperties.SearchClient(4),
                new RateLimitProperties.PostWrite(3),
                new RateLimitProperties.TaxonomyCreate(2),
                new RateLimitProperties.MediaUpload(2));
        RateLimiter limiter = new RateLimiter(tight, nanos::get, 100);
        UUID user = UUID.randomUUID();

        assertThat(allowedCount(limiter, RateLimiter.ROLE_CHANGE, user, 5)).isEqualTo(2);
        assertThat(allowedCount(limiter, RateLimiter.AUTHOR_APPLICATION, user, 5))
                .isEqualTo(1);
        assertThat(allowedCount(limiter, RateLimiter.BOOKMARK, user, 5)).isEqualTo(3);
        assertThat(allowedCount(limiter, RateLimiter.NEWSLETTER_TOKEN, user, 5)).isEqualTo(4);
        assertThat(allowedCount(limiter, RateLimiter.SEARCH, user, 10)).isEqualTo(6);
        assertThat(allowedCount(limiter, RateLimiter.SEARCH_REINDEX, user, 5)).isEqualTo(2);
        assertThat(allowedCount(limiter, RateLimiter.SITE_CONTENT_WRITE, user, 5))
                .isEqualTo(2);
        assertThat(allowedCount(limiter, RateLimiter.POST_IMPORT_WRITE, user, 5))
                .isEqualTo(3);
        assertThat(allowedCount(limiter, RateLimiter.MFA_STEP_UP, user, 5)).isEqualTo(2);
        assertThat(allowedCount(limiter, RateLimiter.PASSWORD_CHANGE, user, 5)).isEqualTo(3);
        assertThat(allowedCount(limiter, RateLimiter.ARTICLE_PREVIEW, user, 6)).isEqualTo(4);
        assertThat(allowedCount(limiter, RateLimiter.COMMENT, user, 5)).isEqualTo(2);
        for (String[] bucketAndLimit : new String[][] {
            {RateLimiter.CONTACT_CLIENT, "2"},
            {RateLimiter.CONTACT_GLOBAL, "3"},
            {RateLimiter.NEWSLETTER_SIGNUP_CLIENT, "2"},
            {RateLimiter.NEWSLETTER_SIGNUP_GLOBAL, "3"},
            {RateLimiter.NEWSLETTER_TOKEN_CLIENT, "2"},
            {RateLimiter.NEWSLETTER_CONFIRM_GLOBAL, "3"},
            {RateLimiter.LOGIN_CLIENT, "2"},
            {RateLimiter.MFA_CLIENT, "2"},
            {RateLimiter.REFRESH_CLIENT, "3"},
            {RateLimiter.SETUP_CLIENT, "2"},
            {RateLimiter.SEARCH_CLIENT, "4"},
        }) {
            int accepted = 0;
            for (int i = 0; i < 10; i++) {
                accepted += limiter.allow(bucketAndLimit[0], "203.0.113.9") ? 1 : 0;
            }
            assertThat(accepted).as(bucketAndLimit[0]).isEqualTo(Integer.parseInt(bucketAndLimit[1]));
        }
        advance(Duration.ofMinutes(1));
        // A new minute, but the hour has only one slot left.
        assertThat(allowedCount(limiter, RateLimiter.COMMENT, user, 5)).isEqualTo(1);
        assertThat(allowedCount(limiter, RateLimiter.COMMENT_EDIT, user, 5)).isEqualTo(1);
        assertThat(allowedCount(limiter, RateLimiter.LIKE, user, 5)).isEqualTo(1);
    }

    @Test
    void non_positive_configuration_makes_the_application_fail_to_start() {
        assertThatThrownBy(() -> new RateLimitProperties.Comment(0, 30))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.rate-limit.comment.per-minute");
        assertThatThrownBy(() -> new RateLimitProperties.Comment(5, -1))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.rate-limit.comment.per-hour");
        assertThatThrownBy(() -> new RateLimitProperties.CommentEdit(0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.rate-limit.comment-edit.per-ten-minutes");
        assertThatThrownBy(() -> new RateLimitProperties.Like(0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.rate-limit.like.per-minute");
        assertThatThrownBy(() -> new RateLimitProperties.PostImportWrite(0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.rate-limit.post-import-write.per-ten-minutes");
        assertThatThrownBy(() -> new RateLimitProperties.ArticlePreview(0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.rate-limit.article-preview.per-ten-minutes");
        assertThatThrownBy(() -> new RateLimitProperties.Login(0, Duration.ofSeconds(5)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.rate-limit.login.concurrent");
        assertThatThrownBy(() -> new RateLimitProperties.Login(2, Duration.ZERO))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.rate-limit.login.max-wait");
        assertThatThrownBy(() -> new RateLimitProperties.Login(2, Duration.ofSeconds(-1)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("app.rate-limit.login.max-wait");
    }

    @Test
    void unknown_action_kind_is_a_programming_error_not_429() {
        RateLimiter limiter = limiter(100);

        assertThatThrownBy(() -> limiter.check("commnet", UUID.randomUUID()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void over_max_keys_cleans_people_silent_past_the_longest_window() {
        RateLimiter limiter = limiter(3);
        List<UUID> quiet = List.of(UUID.randomUUID(), UUID.randomUUID(), UUID.randomUUID());
        quiet.forEach(user -> limiter.check(RateLimiter.LIKE, user));
        assertThat(limiter.trackedKeys(RateLimiter.LIKE)).isEqualTo(3);

        // The longest window of "like" is one minute: past it, the other three people have no attempt left that counts.
        advance(Duration.ofMinutes(1));
        limiter.check(RateLimiter.LIKE, UUID.randomUUID());

        assertThat(limiter.trackedKeys(RateLimiter.LIKE)).isEqualTo(1);
    }

    @Test
    void cleanup_never_removes_a_person_still_blocked() {
        RateLimiter limiter = limiter(3);
        UUID spammer = UUID.randomUUID();
        assertThat(allowedCount(limiter, RateLimiter.COMMENT, spammer, 6)).isEqualTo(5);

        // Many other people push the ledger over the threshold many times while that person is still inside the window.
        for (int i = 0; i < 20; i++) {
            advance(Duration.ofSeconds(1));
            limiter.check(RateLimiter.COMMENT, UUID.randomUUID());
        }

        assertThat(allowed(limiter, RateLimiter.COMMENT, spammer)).isFalse();
    }

    @Test
    void cleanup_uses_the_longest_window_of_that_action_kind() {
        RateLimiter limiter = limiter(2);
        UUID longGone = UUID.randomUUID();
        UUID user = UUID.randomUUID();
        limiter.check(RateLimiter.COMMENT, longGone);
        advance(Duration.ofMinutes(61));
        assertThat(allowedCount(limiter, RateLimiter.COMMENT, user, 5)).isEqualTo(5);

        // Two minutes later: this person's minute limit no longer applies, but those 5 attempts are still inside the
        // hour window. The ledger is over
        // the threshold and gets cleaned: only people silent for more than an hour are dropped.
        advance(Duration.ofMinutes(2));
        limiter.check(RateLimiter.COMMENT, UUID.randomUUID());
        assertThat(limiter.trackedKeys(RateLimiter.COMMENT)).isEqualTo(2);

        // The 5 old attempts still count: 25 more, 5 per minute, reaches 30 per hour.
        for (int minute = 0; minute < 5; minute++) {
            assertThat(allowedCount(limiter, RateLimiter.COMMENT, user, 10))
                    .as("minute %d", minute)
                    .isEqualTo(5);
            advance(Duration.ofMinutes(1));
        }
        assertThat(allowed(limiter, RateLimiter.COMMENT, user)).isFalse();
    }

    @Test
    void many_threads_of_one_person_get_exactly_the_limit() throws Exception {
        RateLimiter limiter = limiter(100);
        UUID user = UUID.randomUUID();
        int threads = 16;
        int attemptsPerThread = 10;
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            List<Future<Integer>> results = new ArrayList<>();
            for (int i = 0; i < threads; i++) {
                Callable<Integer> attempt = () -> {
                    start.await();
                    return allowedCount(limiter, RateLimiter.LIKE, user, attemptsPerThread);
                };
                results.add(pool.submit(attempt));
            }
            start.countDown();

            int accepted = 0;
            for (Future<Integer> result : results) {
                accepted += result.get();
            }
            assertThat(accepted).isEqualTo(30);
        } finally {
            pool.shutdownNow();
        }
    }

    // --- Client addresses and the shared ceilings --------------------------------------------------------------

    @Test
    void the_client_address_buckets_have_their_documented_default_limits_and_windows() {
        RateLimiter limiter = limiter(100);
        Object[][] expected = {
            {RateLimiter.CONTACT_CLIENT, 5, Duration.ofHours(1)},
            {RateLimiter.CONTACT_GLOBAL, 60, Duration.ofHours(1)},
            {RateLimiter.NEWSLETTER_SIGNUP_CLIENT, 5, Duration.ofHours(1)},
            {RateLimiter.NEWSLETTER_SIGNUP_GLOBAL, 120, Duration.ofHours(1)},
            {RateLimiter.NEWSLETTER_TOKEN_CLIENT, 40, Duration.ofHours(1)},
            {RateLimiter.NEWSLETTER_CONFIRM_GLOBAL, 300, Duration.ofHours(1)},
            {RateLimiter.LOGIN_CLIENT, 20, Duration.ofMinutes(10)},
            {RateLimiter.MFA_CLIENT, 20, Duration.ofMinutes(10)},
            {RateLimiter.REFRESH_CLIENT, 60, Duration.ofMinutes(10)},
            {RateLimiter.SETUP_CLIENT, 5, Duration.ofMinutes(1)},
            {RateLimiter.SEARCH_CLIENT, 120, Duration.ofMinutes(1)},
        };
        for (Object[] row : expected) {
            String bucket = (String) row[0];
            int max = (Integer) row[1];
            Duration window = (Duration) row[2];
            int accepted = 0;
            for (int i = 0; i < max + 5; i++) {
                accepted += limiter.allow(bucket, "203.0.113.9") ? 1 : 0;
            }
            assertThat(accepted).as(bucket).isEqualTo(max);

            advance(window.minusNanos(1));
            assertThat(limiter.allow(bucket, "203.0.113.9"))
                    .as(bucket + " just inside the window")
                    .isFalse();
            advance(Duration.ofNanos(1));
            assertThat(limiter.allow(bucket, "203.0.113.9"))
                    .as(bucket + " window passed")
                    .isTrue();
        }
    }

    @Test
    void each_client_address_has_its_own_ledger_and_the_global_key_is_one_ledger_for_everybody() {
        RateLimiter limiter = limiter(100);
        for (int i = 0; i < 5; i++) {
            assertThat(limiter.allow(RateLimiter.CONTACT_CLIENT, "203.0.113.9")).isTrue();
        }
        assertThat(limiter.allow(RateLimiter.CONTACT_CLIENT, "203.0.113.9")).isFalse();
        assertThat(limiter.allow(RateLimiter.CONTACT_CLIENT, "203.0.113.10")).isTrue();

        for (int i = 0; i < 60; i++) {
            assertThat(limiter.allow(RateLimiter.CONTACT_GLOBAL, RateLimiter.GLOBAL_KEY))
                    .isTrue();
        }
        assertThat(limiter.allow(RateLimiter.CONTACT_GLOBAL, RateLimiter.GLOBAL_KEY))
                .isFalse();
        assertThatThrownBy(() -> limiter.check(RateLimiter.CONTACT_GLOBAL, RateLimiter.GLOBAL_KEY))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getCode()).isEqualTo(ErrorCode.RATE_LIMITED);
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
                    assertThat(e.getMessage()).doesNotContain(RateLimiter.GLOBAL_KEY);
                });
    }

    @Test
    void a_flood_of_invented_addresses_cannot_push_a_counted_address_out_of_a_bucket() {
        // maxKeys 3: client buckets hold at most 6 keys while every key is inside its window.
        RateLimiter limiter = limiter(3);
        for (int i = 0; i < 5; i++) {
            assertThat(limiter.allow(RateLimiter.CONTACT_CLIENT, "198.51.100.1"))
                    .isTrue();
        }
        assertThat(limiter.allow(RateLimiter.CONTACT_CLIENT, "198.51.100.1")).isFalse();

        int accepted = 0;
        for (int i = 0; i < 100; i++) {
            advance(Duration.ofMillis(100));
            accepted += limiter.allow(RateLimiter.CONTACT_CLIENT, "203.0.113." + i) ? 1 : 0;
        }

        // Only the free slots were taken: the map never grew past its ceiling ...
        assertThat(accepted).isLessThanOrEqualTo(5);
        assertThat(limiter.trackedKeys(RateLimiter.CONTACT_CLIENT)).isLessThanOrEqualTo(6);
        // ... and the address that was already at its limit is still counted, not forgotten.
        assertThat(limiter.allow(RateLimiter.CONTACT_CLIENT, "198.51.100.1")).isFalse();
    }

    @Test
    void a_full_bucket_takes_new_addresses_again_once_the_old_ones_have_left_their_window() {
        RateLimiter limiter = limiter(3);
        for (int i = 0; i < 6; i++) {
            assertThat(limiter.allow(RateLimiter.CONTACT_CLIENT, "203.0.113." + i))
                    .isTrue();
        }
        assertThat(limiter.allow(RateLimiter.CONTACT_CLIENT, "203.0.113.200")).isFalse();

        // Still inside the hour: the sweep finds nothing to drop and the bucket stays full.
        advance(Duration.ofMinutes(30));
        assertThat(limiter.allow(RateLimiter.CONTACT_CLIENT, "203.0.113.201")).isFalse();

        // The window has passed for every key: they are swept and the new address fits.
        advance(Duration.ofMinutes(31));
        assertThat(limiter.allow(RateLimiter.CONTACT_CLIENT, "203.0.113.202")).isTrue();
        assertThat(limiter.trackedKeys(RateLimiter.CONTACT_CLIENT)).isEqualTo(1);
    }

    // --- The sign-in path evicts instead of refusing (issue 115) --------------------------------------------------

    private static final List<String> SIGN_IN_PATH = List.of(
            RateLimiter.LOGIN_CLIENT, RateLimiter.MFA_CLIENT, RateLimiter.REFRESH_CLIENT, RateLimiter.SETUP_CLIENT);

    @Test
    void a_crowd_that_fills_a_sign_in_bucket_cannot_keep_a_new_address_out() {
        for (String bucket : SIGN_IN_PATH) {
            // maxKeys 3: the bucket holds at most 6 keys. Six addresses, all inside their window, fill it.
            RateLimiter limiter = limiter(3);
            for (int i = 0; i < 6; i++) {
                advance(Duration.ofSeconds(1));
                assertThat(limiter.allow(bucket, "198.51.100." + i)).as(bucket).isTrue();
            }
            assertThat(limiter.trackedKeys(bucket)).as(bucket).isEqualTo(6);

            // The owner arrives from an address nobody has seen: served, not refused, and the map stays bounded.
            advance(Duration.ofSeconds(1));
            assertThat(limiter.allow(bucket, "203.0.113.77")).as(bucket).isTrue();
            assertThat(limiter.trackedKeys(bucket)).as(bucket).isLessThanOrEqualTo(6);
        }
    }

    @Test
    void the_sign_in_buckets_evict_the_stalest_address_and_keep_the_recent_ones_counted() {
        RateLimiter limiter = limiter(3);
        // The oldest address uses up its whole quota (20 sign-in attempts), then five more arrive, one second apart.
        for (int i = 0; i < 20; i++) {
            assertThat(limiter.allow(RateLimiter.LOGIN_CLIENT, "198.51.100.0")).isTrue();
        }
        assertThat(limiter.allow(RateLimiter.LOGIN_CLIENT, "198.51.100.0")).isFalse();
        for (int i = 1; i < 6; i++) {
            advance(Duration.ofSeconds(1));
            assertThat(limiter.allow(RateLimiter.LOGIN_CLIENT, "198.51.100." + i))
                    .isTrue();
        }
        // The freshest address (the sixth) uses up its quota too.
        for (int i = 0; i < 19; i++) {
            assertThat(limiter.allow(RateLimiter.LOGIN_CLIENT, "198.51.100.5")).isTrue();
        }
        assertThat(limiter.allow(RateLimiter.LOGIN_CLIENT, "198.51.100.5")).isFalse();

        // A new address makes room by dropping the stalest key, the first address.
        advance(Duration.ofSeconds(1));
        assertThat(limiter.allow(RateLimiter.LOGIN_CLIENT, "203.0.113.77")).isTrue();

        // The freshest address is still counted and still refused: its running quota was not pushed out.
        assertThat(limiter.allow(RateLimiter.LOGIN_CLIENT, "198.51.100.5")).isFalse();
        // The stalest one starts again as a new key (the price of the ceiling, paid by whoever was idle longest).
        assertThat(limiter.allow(RateLimiter.LOGIN_CLIENT, "198.51.100.0")).isTrue();
    }

    @Test
    void a_flood_of_invented_addresses_never_grows_a_sign_in_bucket_past_its_ceiling_and_never_refuses_one() {
        for (String bucket : SIGN_IN_PATH) {
            RateLimiter limiter = limiter(3);
            for (int i = 0; i < 500; i++) {
                advance(Duration.ofMillis(10));
                assertThat(limiter.allow(bucket, "10.0." + (i / 250) + "." + (i % 250)))
                        .as(bucket + " #" + i)
                        .isTrue();
                assertThat(limiter.trackedKeys(bucket)).as(bucket).isLessThanOrEqualTo(6);
            }
        }
    }

    @Test
    void an_evicting_bucket_drops_a_sixteenth_of_its_ceiling_in_one_pass() {
        // maxKeys 160: the ceiling is 320 keys and a pass drops the 20 stalest, so the next 19 new keys need no pass.
        RateLimiter limiter = limiter(160);
        for (int i = 0; i < 320; i++) {
            advance(Duration.ofMillis(1));
            assertThat(limiter.allow(RateLimiter.REFRESH_CLIENT, "client-" + i)).isTrue();
        }
        assertThat(limiter.trackedKeys(RateLimiter.REFRESH_CLIENT)).isEqualTo(320);

        advance(Duration.ofMillis(1));
        assertThat(limiter.allow(RateLimiter.REFRESH_CLIENT, "new-0")).isTrue();
        assertThat(limiter.trackedKeys(RateLimiter.REFRESH_CLIENT)).isEqualTo(320 - 20 + 1);

        // The 20 stalest (client-0 .. client-19) were dropped: client-0 is a new key again with a whole quota ...
        int freshQuota = 0;
        for (int i = 0; i < 60; i++) {
            freshQuota += limiter.allow(RateLimiter.REFRESH_CLIENT, "client-0") ? 1 : 0;
        }
        assertThat(freshQuota).isEqualTo(60);
        // ... while client-20, the next in line, was kept with the one attempt it had already used.
        int keptQuota = 0;
        for (int i = 0; i < 60; i++) {
            keptQuota += limiter.allow(RateLimiter.REFRESH_CLIENT, "client-20") ? 1 : 0;
        }
        assertThat(keptQuota).isEqualTo(59);

        // The next new keys fit without another pass until the map is full again.
        int size = limiter.trackedKeys(RateLimiter.REFRESH_CLIENT);
        for (int i = 1; i <= 10; i++) {
            advance(Duration.ofMillis(1));
            assertThat(limiter.allow(RateLimiter.REFRESH_CLIENT, "new-" + i)).isTrue();
            assertThat(limiter.trackedKeys(RateLimiter.REFRESH_CLIENT)).isEqualTo(size + i);
        }
    }

    @Test
    void the_buckets_outside_the_sign_in_path_still_refuse_a_new_address_when_full() {
        for (String bucket : List.of(
                RateLimiter.CONTACT_CLIENT,
                RateLimiter.NEWSLETTER_SIGNUP_CLIENT,
                RateLimiter.NEWSLETTER_TOKEN_CLIENT,
                RateLimiter.SEARCH_CLIENT)) {
            RateLimiter limiter = limiter(3);
            for (int i = 0; i < 6; i++) {
                advance(Duration.ofSeconds(1));
                assertThat(limiter.allow(bucket, "198.51.100." + i)).as(bucket).isTrue();
            }

            assertThat(limiter.allow(bucket, "203.0.113.77")).as(bucket).isFalse();
            assertThat(limiter.trackedKeys(bucket)).as(bucket).isEqualTo(6);
        }
    }

    @Test
    void a_full_bucket_still_serves_an_address_it_already_counts() {
        RateLimiter limiter = limiter(3);
        for (int i = 0; i < 6; i++) {
            assertThat(limiter.allow(RateLimiter.SEARCH_CLIENT, "203.0.113." + i))
                    .isTrue();
        }

        // The seventh address is refused, the first six keep their exact quota (120 per minute, 1 used).
        assertThat(limiter.allow(RateLimiter.SEARCH_CLIENT, "203.0.113.99")).isFalse();
        assertThat(limiter.allow(RateLimiter.SEARCH_CLIENT, "203.0.113.0")).isTrue();
    }

    @Test
    void the_newsletter_signup_address_keys_are_bounded_too_because_the_caller_chooses_them() {
        RateLimiter limiter = limiter(3);
        int accepted = 0;
        for (int i = 0; i < 50; i++) {
            accepted += limiter.allow(RateLimiter.NEWSLETTER_SIGNUP, "someone+" + i + "@example.com") ? 1 : 0;
        }

        assertThat(accepted).isEqualTo(6);
        assertThat(limiter.trackedKeys(RateLimiter.NEWSLETTER_SIGNUP)).isEqualTo(6);
    }

    @Test
    void user_keyed_buckets_have_no_ceiling_of_their_own() {
        // The people of these buckets are signed-in accounts, not values a caller invents: nobody is ever refused for
        // room.
        RateLimiter limiter = limiter(3);
        for (int i = 0; i < 30; i++) {
            limiter.check(RateLimiter.LIKE, UUID.randomUUID());
        }

        assertThat(limiter.trackedKeys(RateLimiter.LIKE)).isEqualTo(30);
    }

    @Test
    void chain_key_by_address_allow_returns_false_when_over_while_check_throws_429_and_each_bucket_has_own_ledger() {
        RateLimiter limiter = new RateLimiter(DEFAULTS, nanos::get, 100);
        String address = "a@example.com";

        assertThat(limiter.allow(RateLimiter.NEWSLETTER_SIGNUP, address)).isTrue();
        assertThat(limiter.allow(RateLimiter.NEWSLETTER_SIGNUP, address)).isTrue();
        assertThat(limiter.allow(RateLimiter.NEWSLETTER_SIGNUP, address)).isTrue();
        assertThat(limiter.allow(RateLimiter.NEWSLETTER_SIGNUP, address)).isFalse();
        assertThat(limiter.allow(RateLimiter.NEWSLETTER_SIGNUP, "b@example.com"))
                .isTrue();

        for (int i = 0; i < 20; i++) {
            limiter.check(RateLimiter.NEWSLETTER_TOKEN, address);
        }
        assertThatThrownBy(() -> limiter.check(RateLimiter.NEWSLETTER_TOKEN, address))
                .isInstanceOf(ApiException.class);

        nanos.addAndGet(Duration.ofHours(1).toNanos() + 1);
        assertThat(limiter.allow(RateLimiter.NEWSLETTER_SIGNUP, address)).isTrue();
    }

    @Test
    void the_author_write_buckets_each_have_their_own_window() {
        RateLimiter limiter = limiter(100);
        UUID user = UUID.randomUUID();

        assertThat(allowedCount(limiter, RateLimiter.POST_WRITE, user, 70)).isEqualTo(60);
        assertThat(allowedCount(limiter, RateLimiter.TAXONOMY_CREATE, user, 15)).isEqualTo(10);
        assertThat(allowedCount(limiter, RateLimiter.MEDIA_UPLOAD, user, 40)).isEqualTo(30);

        // Ten minutes later the two ten-minute windows are open again; the hourly one is not.
        advance(Duration.ofMinutes(10));
        assertThat(allowed(limiter, RateLimiter.POST_WRITE, user)).isTrue();
        assertThat(allowed(limiter, RateLimiter.MEDIA_UPLOAD, user)).isTrue();
        assertThat(allowed(limiter, RateLimiter.TAXONOMY_CREATE, user)).isFalse();
        advance(Duration.ofMinutes(50));
        assertThat(allowed(limiter, RateLimiter.TAXONOMY_CREATE, user)).isTrue();
        // One author's limit is not another's.
        assertThat(allowed(limiter, RateLimiter.TAXONOMY_CREATE, UUID.randomUUID()))
                .isTrue();
    }
}
