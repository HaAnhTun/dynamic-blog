package com.blog.common.exception;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.common.limits.RequestBodyTooLargeException;
import java.io.IOException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.mock.http.MockHttpInputMessage;

/**
 * A chunked body that went past its ceiling surfaces as an {@link RequestBodyTooLargeException} inside whatever the JSON reader
 * wraps it in (issues 118 and 036). It must come out as the same 413 that the size filter gives to a request that declares
 * its length, not as the 400 "Malformed request body" of a broken document.
 */
class GlobalExceptionHandlerBodyLimitTest {

    private final GlobalExceptionHandler handler = new GlobalExceptionHandler();

    private static HttpMessageNotReadableException unreadable(Throwable cause) {
        return new HttpMessageNotReadableException("cannot read", cause, new MockHttpInputMessage(new byte[0]));
    }

    @Test
    void an_oversized_streamed_body_is_a_413_not_a_400() {
        // Two wrappers deep, like Jackson 3 around the IOException of the stream.
        Throwable wrapped =
                new IllegalStateException("reader failed", new IOException("io", new RequestBodyTooLargeException(10)));

        var response = handler.handleMessageNotReadable(unreadable(wrapped));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONTENT_TOO_LARGE);
        assertThat(response.getBody().error().code()).isEqualTo("VALIDATION_ERROR");
        assertThat(response.getBody().error().message()).isEqualTo("The request body is too large");
        assertThat(response.getBody().error().traceId()).isNotBlank();
    }

    @Test
    void a_broken_document_is_still_a_400() {
        var response = handler.handleMessageNotReadable(unreadable(new IllegalStateException("not json")));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody().error().message()).isEqualTo("Malformed request body");
    }

    @Test
    void the_catch_all_recognises_it_too() {
        var response = handler.handleUnexpected(new RuntimeException("outer", new RequestBodyTooLargeException(10)));

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONTENT_TOO_LARGE);
    }
}
