package com.blog.common.exception;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.security.access.AccessDeniedException;

/**
 * What the handler writes to the log. A domain message can repeat what the caller typed (a tag name that already
 * exists), and tag creation is open to an AUTHOR, so a line break in the message must not start a forged log line. A client
 * error such as that conflict is DEBUG without its message (issue 089); the message reaches a line at WARN or above, for a
 * server error and for a refusal inside a service, and there it is one line.
 */
class GlobalExceptionHandlerLogTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler();
    private final Logger logger = (Logger) LoggerFactory.getLogger(GlobalExceptionHandler.class);
    private ListAppender<ILoggingEvent> appender;

    @BeforeEach
    void capture() {
        appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        logger.setLevel(Level.INFO);
    }

    @AfterEach
    void release() {
        logger.detachAppender(appender);
    }

    @Test
    void an_api_exception_message_with_a_line_break_is_one_log_event_with_no_line_break() {
        handler.handleApiException(new ApiException(
                ErrorCode.SEARCH_REINDEX_FAILED,
                HttpStatus.BAD_GATEWAY,
                "Index 'a\r\n2026-01-01 ERROR forged line' failed"));

        assertThat(appender.list).hasSize(1);
        String line = appender.list.get(0).getFormattedMessage();
        assertThat(line).doesNotContain("\r").doesNotContain("\n").contains("SEARCH_REINDEX_FAILED");
    }

    @Test
    void a_client_error_that_repeats_a_typed_name_is_not_logged_at_info_at_all() {
        handler.handleApiException(new ApiException(
                ErrorCode.TAG_ALREADY_EXISTS,
                HttpStatus.CONFLICT,
                "Tag 'a\r\n2026-01-01 ERROR forged line' already exists"));

        assertThat(appender.list).isEmpty();
    }

    @Test
    void the_response_still_carries_the_message_as_it_was() {
        var response = handler.handleApiException(
                new ApiException(ErrorCode.TAG_ALREADY_EXISTS, HttpStatus.CONFLICT, "Tag 'a\nb' already exists"));

        assertThat(response.getBody().error().message()).isEqualTo("Tag 'a\nb' already exists");
    }

    @Test
    void an_access_denied_message_is_cleaned_too() {
        handler.handleAccessDenied(new AccessDeniedException("denied\r\nforged"), new MockHttpServletRequest());

        assertThat(appender.list).hasSize(1);
        assertThat(appender.list.get(0).getFormattedMessage())
                .doesNotContain("\r")
                .doesNotContain("\n");
    }
}
