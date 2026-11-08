package com.blog.post.service;

import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.blog.analytics.config.AnalyticsProperties;
import com.blog.analytics.service.ViewSourceClassifier;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.post.config.ViewsProperties;
import com.blog.post.repository.PostViewRepository;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InOrder;
import org.mockito.Mock;
import org.mockito.MockedStatic;
import org.mockito.junit.jupiter.MockitoExtension;

/**
 * The part of the view counter that needs no DB: the optional shared token {@code app.views.token} and the answer when
 * there is no post to count. The token is set directly on ViewsProperties here instead of {@code @TestPropertySource} in an IT:
 * every extra property set means one more Spring context. PostViewsIT runs with an empty token, like dev and compose.
 */
@ExtendWith(MockitoExtension.class)
class PostViewServiceTest {

    private static final String SLUG = "bai-co-nguoi-xem";
    private static final String TOKEN = "k7Qp-2xV9mZr-views";
    /** 00:30 on 10/10 Vietnam time, when the UTC date is still 9/10. */
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-10-09T17:30:00Z"), ZoneOffset.UTC);

    private static final LocalDate LOCAL_DAY = LocalDate.parse("2026-10-10");

    @Mock
    private PostViewRepository postViewRepository;

    // --- Empty token: anyone can count -----------------------------------------------------------

    @Test
    void empty_or_blank_token_needs_no_header() {
        when(postViewRepository.incrementBySlug(SLUG)).thenReturn(1);

        // null: key absent from the config; "": ${VIEWS_TOKEN:} when the variable is unset; whitespace: the Next side
        // trims this
        // variable and treats it as unset, so it sends no header. Both sides must be open together, or every view
        // becomes a 403.
        for (String blank : Arrays.asList(null, "", "  \t ")) {
            service(blank).record(SLUG, null, null);
        }

        verify(postViewRepository, times(3)).incrementBySlug(SLUG);
    }

    // --- Token set: the header must match --------------------------------------------------------

    @Test
    void configured_token_with_missing_or_wrong_header_is_403_FORBIDDEN_and_not_counted() {
        PostViewService service = service(TOKEN);
        List<String> wrong = Arrays.asList(
                null,
                "",
                "   ",
                TOKEN.substring(0, TOKEN.length() - 1),
                TOKEN + "x",
                TOKEN.toUpperCase(Locale.ROOT),
                "Bearer " + TOKEN);

        for (String header : wrong) {
            assertRejected(() -> service.record(SLUG, header, "www.google.com"), ErrorCode.FORBIDDEN, 403);
        }

        // Rejected before touching the DB: without the token no view is counted (neither total nor per day), and no
        // slug can be probed for being a real post through the 404 answer.
        verify(postViewRepository, never()).incrementBySlug(anyString());
        verify(postViewRepository, never()).incrementDailyBySlug(anyString(), any(), anyString());
    }

    @Test
    void configured_token_and_matching_header_counts_exactly_one_view() {
        when(postViewRepository.incrementBySlug(SLUG)).thenReturn(1);

        // A fresh string rather than the configured object itself: compared by content, not by reference.
        service(TOKEN).record(SLUG, new String(TOKEN.toCharArray()), null);

        verify(postViewRepository).incrementBySlug(SLUG);
    }

    @Test
    void configured_token_is_trimmed_like_the_Next_side() {
        when(postViewRepository.incrementBySlug(SLUG)).thenReturn(1);

        // Next sends process.env.VIEWS_TOKEN already trimmed, and the backend reads the same variable. Without trimming
        // here a stray space or
        // newline in the .env file turns every view into a 403, silently: Next ignores counting errors and does not
        // log.
        service("  " + TOKEN + "\n").record(SLUG, TOKEN, null);

        verify(postViewRepository).incrementBySlug(SLUG);
    }

    @Test
    void token_is_compared_with_MessageDigest_isEqual_both_when_matching_and_when_wrong() {
        when(postViewRepository.incrementBySlug(SLUG)).thenReturn(1);
        PostViewService service = service(TOKEN);
        String wrong = "x".repeat(TOKEN.length());

        try (MockedStatic<MessageDigest> digest = mockStatic(MessageDigest.class, CALLS_REAL_METHODS)) {
            service.record(SLUG, TOKEN, null);
            assertRejected(() -> service.record(SLUG, wrong, null), ErrorCode.FORBIDDEN, 403);

            // String.equals stops at the first wrong character: timing the answer of a public endpoint would reveal the
            // token
            // one character at a time. MessageDigest.isEqual walks the whole length of the first argument (the
            // configured token) wherever it differs.
            digest.verify(() -> MessageDigest.isEqual(TOKEN.getBytes(UTF_8), TOKEN.getBytes(UTF_8)));
            digest.verify(() -> MessageDigest.isEqual(TOKEN.getBytes(UTF_8), wrong.getBytes(UTF_8)));
        }
    }

    // --- No post to count ------------------------------------------------------------------------

    @Test
    void no_published_post_with_that_slug_is_404_POST_NOT_FOUND_with_or_without_token() {
        // incrementBySlug touches only PUBLISHED posts: 0 rows means an unknown slug, an unpublished post or a
        // taken-down post (PostViewsIT checks
        // each case against a real DB).
        when(postViewRepository.incrementBySlug("khong-co-bai-nay")).thenReturn(0);

        assertRejected(() -> service("").record("khong-co-bai-nay", null, null), ErrorCode.POST_NOT_FOUND, 404);
        // With the right token it passes the token step and only then reaches the 404 answer.
        assertRejected(() -> service(TOKEN).record("khong-co-bai-nay", TOKEN, null), ErrorCode.POST_NOT_FOUND, 404);
        // If the total cannot be counted there is no per-day row either.
        verify(postViewRepository, never()).incrementDailyBySlug(anyString(), any(), anyString());
    }

    // --- Per day and source ------------------------------------------------------------------------

    @Test
    void counted_view_increments_total_first_then_local_day_row_and_source_group() {
        when(postViewRepository.incrementBySlug(SLUG)).thenReturn(1);
        PostViewService service = service("");

        service.record(SLUG, null, "www.google.com.vn");
        service.record(SLUG, null, null);
        service.record(SLUG, null, "https://evil.example/x?y=1");

        // Total first, daily row second: every view takes its locks in the same order. The day follows
        // Asia/Ho_Chi_Minh, not the
        // JVM's UTC; the header only decides the group, the host does not go down to the repository.
        InOrder order = inOrder(postViewRepository);
        order.verify(postViewRepository).incrementBySlug(SLUG);
        order.verify(postViewRepository).incrementDailyBySlug(SLUG, LOCAL_DAY, "search");
        order.verify(postViewRepository).incrementBySlug(SLUG);
        order.verify(postViewRepository).incrementDailyBySlug(SLUG, LOCAL_DAY, "direct");
        order.verify(postViewRepository).incrementBySlug(SLUG);
        order.verify(postViewRepository).incrementDailyBySlug(SLUG, LOCAL_DAY, "other");
        order.verifyNoMoreInteractions();
    }

    // --- Configuration -----------------------------------------------------------------------------

    @Test
    void configuration_printout_does_not_leak_token() {
        ViewsProperties properties = new ViewsProperties(TOKEN);

        // Control: the token is still readable through the accessor...
        assertThat(properties.token()).isEqualTo(TOKEN);
        // ...but does not follow toString (a record's generated toString prints every component), so it does not leak
        // into logs or
        // any error message that prints the configuration.
        assertThat(properties.toString()).doesNotContain(TOKEN);
    }

    private PostViewService service(String token) {
        return new PostViewService(
                postViewRepository,
                new ViewsProperties(token),
                new ViewSourceClassifier(""),
                new AnalyticsProperties("Asia/Ho_Chi_Minh"),
                CLOCK);
    }

    private static void assertRejected(ThrowingCallable call, ErrorCode code, int status) {
        assertThatThrownBy(call).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(code);
            assertThat(e.getStatus().value()).isEqualTo(status);
        });
    }
}
