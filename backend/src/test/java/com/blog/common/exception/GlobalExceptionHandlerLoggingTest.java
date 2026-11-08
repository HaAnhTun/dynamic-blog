package com.blog.common.exception;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;

/**
 * What {@link GlobalExceptionHandler} writes to the log (issue 089). Anonymous traffic can produce a 404 or a 400 at will
 * and nothing limits it, so those answers must not fill the log at WARN with text the caller chose: the 3 x 10 MB log
 * window of the Compose file would then hold nothing but them, and the security events (refresh-token reuse, failed
 * sign-ins, second-step failures) would be rotated out. Plain unit test: the handler needs no Spring context.
 */
class GlobalExceptionHandlerLoggingTest {

    private static final String MARKER = "slug-chosen-by-the-caller-7f3a";

    private final AtomicLong nanos = new AtomicLong();
    private final GlobalExceptionHandler handler = new GlobalExceptionHandler(nanos::get);
    private final Logger logger = (Logger) LoggerFactory.getLogger(GlobalExceptionHandler.class);
    private final ListAppender<ILoggingEvent> events = new ListAppender<>();
    private Level previousLevel;

    @BeforeEach
    void capture() {
        previousLevel = logger.getLevel();
        // DEBUG, so that the test sees every line the handler writes at any level.
        logger.setLevel(Level.DEBUG);
        events.start();
        logger.addAppender(events);
    }

    @AfterEach
    void release() {
        logger.detachAppender(events);
        logger.setLevel(previousLevel);
        events.stop();
    }

    private List<ILoggingEvent> atWarnOrAbove() {
        return events.list.stream()
                .filter(event -> event.getLevel().isGreaterOrEqual(Level.WARN))
                .toList();
    }

    @Test
    void a_not_found_for_an_unknown_slug_is_not_logged_at_warn_and_never_with_the_slug() {
        var response = handler.handleApiException(
                new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + MARKER));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(atWarnOrAbove()).isEmpty();
        assertThat(events.list)
                .allSatisfy(event -> assertThat(event.getFormattedMessage()).doesNotContain(MARKER));
        // The caller still gets the code and the trace id in the answer; the log keeps the code and the same trace id.
        assertThat(response.getBody().error().traceId()).isNotBlank();
        assertThat(events.list)
                .anySatisfy(event -> assertThat(event.getFormattedMessage())
                        .contains("POST_NOT_FOUND")
                        .contains(response.getBody().error().traceId()));
    }

    @Test
    void other_client_errors_that_anonymous_traffic_can_produce_are_not_logged_at_warn() {
        handler.handleApiException(
                new ApiException(ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "Invalid value: " + MARKER));
        handler.handleApiException(
                new ApiException(ErrorCode.RESOURCE_CONFLICT, HttpStatus.CONFLICT, "Already exists: " + MARKER));
        handler.handleUnexpected(new HttpRequestMethodNotSupportedException("DELETE"));

        assertThat(atWarnOrAbove()).isEmpty();
        assertThat(events.list)
                .allSatisfy(event -> assertThat(event.getFormattedMessage()).doesNotContain(MARKER));
    }

    @Test
    void an_unauthenticated_forbidden_or_rate_limited_answer_stays_at_warn_without_the_message() {
        handler.handleApiException(new ApiException(ErrorCode.FORBIDDEN, HttpStatus.FORBIDDEN, "Not yours: " + MARKER));
        handler.handleApiException(
                new ApiException(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "Too many: " + MARKER));
        handler.handleApiException(
                new ApiException(ErrorCode.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED, "Sign in: " + MARKER));

        assertThat(atWarnOrAbove()).hasSize(3);
        assertThat(events.list)
                .allSatisfy(event -> assertThat(event.getFormattedMessage()).doesNotContain(MARKER));
    }

    @Test
    void repeated_rate_limit_answers_write_one_warn_line_not_one_per_request() {
        for (int i = 0; i < 500; i++) {
            handler.handleApiException(
                    new ApiException(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "Too many: " + MARKER));
        }

        assertThat(atWarnOrAbove()).hasSize(1);
        assertThat(atWarnOrAbove().get(0).getFormattedMessage())
                .contains("RATE_LIMITED")
                .contains("429");
        // The repeats are still there for whoever turns DEBUG on, each with its own trace id.
        assertThat(events.list).hasSize(500);
        assertThat(events.list)
                .allSatisfy(event -> assertThat(event.getFormattedMessage()).doesNotContain(MARKER));
    }

    @Test
    void each_rate_limit_code_has_its_own_line_and_a_later_line_counts_what_it_left_out() {
        ApiException plain = new ApiException(ErrorCode.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "slow down");
        ApiException second = new ApiException(ErrorCode.MFA_RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, "slow down");
        handler.handleApiException(plain);
        handler.handleApiException(second);
        handler.handleApiException(plain);
        handler.handleApiException(plain);

        assertThat(atWarnOrAbove()).hasSize(2);
        assertThat(atWarnOrAbove().get(0).getFormattedMessage())
                .contains("code=RATE_LIMITED ")
                .doesNotContain("similar");
        assertThat(atWarnOrAbove().get(1).getFormattedMessage()).contains("MFA_RATE_LIMITED");

        // A minute later the next refusal is a WARN line again and says how many were left out since the last one.
        nanos.addAndGet(Duration.ofSeconds(61).toNanos());
        handler.handleApiException(plain);

        assertThat(atWarnOrAbove()).hasSize(3);
        assertThat(atWarnOrAbove().get(2).getFormattedMessage())
                .contains("code=RATE_LIMITED ")
                .contains("2 similar");
    }

    @Test
    void a_server_error_is_still_logged_at_warn_or_above() {
        handler.handleApiException(
                new ApiException(ErrorCode.SEARCH_REINDEX_FAILED, HttpStatus.BAD_GATEWAY, "The reindex stopped"));
        handler.handleUnexpected(new IllegalStateException("boom"));

        assertThat(atWarnOrAbove()).hasSize(2);
        assertThat(atWarnOrAbove().get(0).getFormattedMessage()).contains("SEARCH_REINDEX_FAILED");
        assertThat(atWarnOrAbove().get(1).getLevel()).isEqualTo(Level.ERROR);
    }

    @Test
    void repeated_oversized_uploads_write_one_warn_line_a_minute_and_the_next_one_counts_what_it_left_out() {
        for (int i = 0; i < 200; i++) {
            handler.handleUploadTooLarge(new MaxUploadSizeExceededException(1_000));
        }

        // One WARN line for the first, the other 199 only at DEBUG, each with its own trace id.
        assertThat(atWarnOrAbove()).hasSize(1);
        assertThat(atWarnOrAbove().get(0).getFormattedMessage()).doesNotContain("similar");
        assertThat(events.list).hasSize(200);

        nanos.addAndGet(Duration.ofSeconds(61).toNanos());
        handler.handleUploadTooLarge(new MaxUploadSizeExceededException(1_000));

        assertThat(atWarnOrAbove()).hasSize(2);
        assertThat(atWarnOrAbove().get(1).getFormattedMessage()).contains("199 similar");
    }

    @Test
    void an_oversized_upload_still_answers_413_with_the_media_code() {
        var response = handler.handleUploadTooLarge(new MaxUploadSizeExceededException(1_000));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONTENT_TOO_LARGE);
        assertThat(response.getBody().error().code()).isEqualTo(ErrorCode.MEDIA_TOO_LARGE.name());
    }
}
