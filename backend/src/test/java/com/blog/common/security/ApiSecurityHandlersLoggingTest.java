package com.blog.common.security;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.common.util.LogText;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.InsufficientAuthenticationException;
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException;
import tools.jackson.databind.json.JsonMapper;

/**
 * What the two filter-path handlers write to the log (issue 089). A request without any credential is the cheapest thing an
 * anonymous caller can send, and the path of it is whatever the caller chose, up to the header limit of the container (about
 * 8 KB). It must not reach WARN, where the 3 x 10 MB window of the Compose file would hold nothing else after a few thousand
 * of them. The lines that stay at WARN carry a bounded prefix of the path, never the whole of it.
 */
class ApiSecurityHandlersLoggingTest {

    private static final String LONG_PATH = "/api/v1/" + "x".repeat(8000);

    private final JsonMapper mapper = JsonMapper.builder().build();
    private final ApiAuthenticationEntryPoint entryPoint = new ApiAuthenticationEntryPoint(mapper);
    private final ApiAccessDeniedHandler deniedHandler = new ApiAccessDeniedHandler(mapper);
    private final ListAppender<ILoggingEvent> events = new ListAppender<>();
    private final List<Logger> loggers =
            List.of((Logger) LoggerFactory.getLogger(ApiAuthenticationEntryPoint.class), (Logger)
                    LoggerFactory.getLogger(ApiAccessDeniedHandler.class));
    private List<Level> previousLevels;

    @BeforeEach
    void capture() {
        previousLevels = loggers.stream().map(Logger::getLevel).toList();
        events.start();
        for (Logger logger : loggers) {
            // DEBUG, so that the test sees every line the handlers write at any level.
            logger.setLevel(Level.DEBUG);
            logger.addAppender(events);
        }
    }

    @AfterEach
    void release() {
        for (int i = 0; i < loggers.size(); i++) {
            loggers.get(i).detachAppender(events);
            loggers.get(i).setLevel(previousLevels.get(i));
        }
        events.stop();
    }

    private List<ILoggingEvent> atWarnOrAbove() {
        return events.list.stream()
                .filter(event -> event.getLevel().isGreaterOrEqual(Level.WARN))
                .toList();
    }

    @Test
    void a_request_without_a_credential_is_not_a_warn_line_whatever_its_path() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", LONG_PATH);
        MockHttpServletResponse response = new MockHttpServletResponse();

        entryPoint.commence(request, response, new InsufficientAuthenticationException("Full authentication"));

        assertThat(response.getStatus()).isEqualTo(401);
        assertThat(atWarnOrAbove()).isEmpty();
        // The answer still carries its trace id, and at DEBUG the log can be matched to it.
        String traceId = mapper.readTree(response.getContentAsString())
                .path("error")
                .path("traceId")
                .asString();
        assertThat(events.list).singleElement().satisfies(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.DEBUG);
            assertThat(event.getFormattedMessage()).contains(traceId);
            assertThat(event.getFormattedMessage()).doesNotContain("x".repeat(LogText.PATH_MAX + 1));
        });
    }

    @Test
    void a_rejected_token_stays_at_warn_with_a_bounded_path_and_without_the_token() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", LONG_PATH);
        request.setQueryString("access_token=secret-token-value");
        request.addHeader("Authorization", "Bearer secret-token-value");

        entryPoint.commence(
                request,
                new MockHttpServletResponse(),
                new InvalidBearerTokenException("Jwt expired at 2026-01-01T00:00:00Z secret-token-value"));

        assertThat(atWarnOrAbove()).singleElement().satisfies(event -> {
            String line = event.getFormattedMessage();
            assertThat(line).contains("InvalidBearerTokenException").contains("/api/v1/xxx");
            assertThat(line).doesNotContain("x".repeat(LogText.PATH_MAX + 1));
            assertThat(line).doesNotContain("secret-token-value").doesNotContain("expired at");
        });
    }

    @Test
    void a_forbidden_answer_stays_at_warn_with_a_bounded_path() throws Exception {
        MockHttpServletRequest request = new MockHttpServletRequest("DELETE", LONG_PATH);
        request.setQueryString("q=secret-query");

        deniedHandler.handle(request, new MockHttpServletResponse(), new AccessDeniedException("no"));

        assertThat(atWarnOrAbove()).singleElement().satisfies(event -> {
            String line = event.getFormattedMessage();
            assertThat(line).contains("DELETE").contains("/api/v1/xxx");
            assertThat(line).doesNotContain("x".repeat(LogText.PATH_MAX + 1)).doesNotContain("secret-query");
        });
    }

    @Test
    void a_flood_of_rejected_tokens_writes_one_warn_line_a_minute_and_the_next_one_counts_what_it_left_out()
            throws Exception {
        AtomicLong nanos = new AtomicLong();
        ApiAuthenticationEntryPoint throttled = new ApiAuthenticationEntryPoint(mapper, nanos::get);

        // "Authorization: Bearer <junk>" costs an anonymous caller nothing and is refused by the resource server.
        for (int i = 0; i < 300; i++) {
            throttled.commence(
                    new MockHttpServletRequest("GET", "/api/v1/admin/posts"),
                    new MockHttpServletResponse(),
                    new InvalidBearerTokenException("Invalid token"));
        }

        assertThat(atWarnOrAbove()).hasSize(1);
        assertThat(atWarnOrAbove().get(0).getFormattedMessage()).doesNotContain("similar");
        // The repeats are still logged for whoever turns DEBUG on, each with its own trace id.
        assertThat(events.list).hasSize(300);

        nanos.addAndGet(Duration.ofSeconds(61).toNanos());
        throttled.commence(
                new MockHttpServletRequest("GET", "/api/v1/admin/posts"),
                new MockHttpServletResponse(),
                new InvalidBearerTokenException("Invalid token"));

        assertThat(atWarnOrAbove()).hasSize(2);
        assertThat(atWarnOrAbove().get(1).getFormattedMessage()).contains("299 similar");
    }

    @Test
    void a_throttled_rejection_still_answers_401_with_the_envelope() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        for (int i = 0; i < 3; i++) {
            response = new MockHttpServletResponse();
            entryPoint.commence(
                    new MockHttpServletRequest("GET", "/api/v1/admin/posts"),
                    response,
                    new InvalidBearerTokenException("Invalid token"));
        }

        assertThat(response.getStatus()).isEqualTo(401);
        assertThat(mapper.readTree(response.getContentAsString())
                        .path("error")
                        .path("code")
                        .asString())
                .isEqualTo("UNAUTHENTICATED");
    }
}
