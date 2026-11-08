package com.blog.common.exception;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.not;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.blog.support.AbstractIntegrationTest;
import org.apache.tomcat.util.http.InvalidParameterException;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.test.web.servlet.MockMvc;

// This test's subject is GlobalExceptionHandler and Spring MVC's own exception
// translation, not Security - addFilters = false takes the filter chain (and therefore
// this task's denyAll fallback) out of the picture entirely, so the two /api/v1/** probes
// below can stay on their original targets and keep proving what they were written to
// prove, rather than a relocated approximation of it.
@AutoConfigureMockMvc(addFilters = false)
class GlobalExceptionHandlerTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void apiExceptionIsTranslatedToErrorEnvelope() throws Exception {
        mockMvc.perform(post("/__test/throw-api-exception"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("POST_NOT_FOUND"))
                .andExpect(jsonPath("$.error.message").value("Post not found"))
                .andExpect(jsonPath("$.error.traceId").exists());
    }

    @Test
    void validationErrorIsTranslatedToErrorEnvelope() throws Exception {
        mockMvc.perform(post("/__test/validate")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test
    void dataIntegrityViolationIsTranslatedToErrorEnvelope() throws Exception {
        mockMvc.perform(post("/__test/throw-data-integrity-violation"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.error.code").value("RESOURCE_CONFLICT"))
                .andExpect(jsonPath("$.error.traceId").exists());
    }

    @Test
    void unexpectedExceptionIsTranslatedToErrorEnvelopeWithoutLeakingDetails() throws Exception {
        mockMvc.perform(post("/__test/throw-runtime-exception"))
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.error.code").value("INTERNAL_ERROR"))
                .andExpect(jsonPath("$.error.message", not(containsString("boom"))))
                .andExpect(jsonPath("$.error.traceId").exists());
    }

    @Test
    void multipart_upload_over_limit_returns_413_media_too_large() throws Exception {
        // The same code as the limit checked in code (MediaService), so the admin gets one "image too large" message no
        // matter which layer blocks it. Without a dedicated handler this exception would still produce 413 but through
        // the framework error branch with
        // the generic VALIDATION_ERROR code, and the UI could not tell it from a broken request.
        mockMvc.perform(post("/__test/throw-max-upload-size"))
                .andExpect(status().isContentTooLarge())
                .andExpect(jsonPath("$.error.code").value("MEDIA_TOO_LARGE"))
                .andExpect(jsonPath("$.error.message").isNotEmpty())
                .andExpect(jsonPath("$.error.traceId").exists());
    }

    @Test
    void malformedJsonIsTranslatedToErrorEnvelope() throws Exception {
        mockMvc.perform(post("/__test/validate")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{not-valid-json"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    }

    @Test
    void undecodable_tomcat_parameter_is_400_validation_error_not_500() throws Exception {
        // A query string with a bad % escape (%FF): Tomcat throws InvalidParameterException when Spring asks for the
        // parameter. MockMvc does not
        // decode the query string, so the fake request throws exactly that exception at the place Spring asks
        // (getParameterMap is left alone: the
        // MockMvc request printer calls it after processing has finished).
        mockMvc.perform(servletContext -> new MockHttpServletRequest(servletContext, "GET", "/api/v1/posts/search") {
                    @Override
                    public String getParameter(String name) {
                        throw undecodable();
                    }

                    @Override
                    public String[] getParameterValues(String name) {
                        throw undecodable();
                    }
                })
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"))
                .andExpect(jsonPath("$.error.message").value("Malformed request parameters"))
                .andExpect(jsonPath("$.error.traceId").exists());
    }

    private static InvalidParameterException undecodable() {
        return new InvalidParameterException("Character decoding failed. Parameter [q] with value [%FF] ignored");
    }

    @Test
    void nonNumericPageParamOnPublicPostsListReturns400WithErrorEnvelope() throws Exception {
        mockMvc.perform(get("/api/v1/posts").param("page", "abc"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error.code").exists());
    }

    @Test
    void unmappedPathReturns404WithErrorEnvelopeInsteadOf500() throws Exception {
        // Regression: @RestControllerAdvice with no selectors intercepts framework-owned
        // conditions too, so an unmapped route reaches the Exception.class catch-all - which
        // must not fabricate a 500 out of Spring's own NoResourceFoundException (404).
        mockMvc.perform(get("/api/v1/this-route-does-not-exist"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error.code").value("ENDPOINT_NOT_FOUND"))
                .andExpect(jsonPath("$.error.traceId").exists());
    }

    @Test
    void wrongHttpMethodOnMappedRouteReturns405WithErrorEnvelopeInsteadOf500() throws Exception {
        // /api/v1/posts only maps GET; DELETE against the same path matches the route but not
        // the method, so Spring throws HttpRequestMethodNotSupportedException (405).
        mockMvc.perform(delete("/api/v1/posts"))
                .andExpect(status().isMethodNotAllowed())
                .andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"))
                .andExpect(jsonPath("$.error.traceId").exists());
    }

    @Test
    void a_public_404_for_an_unknown_slug_never_writes_the_slug_to_the_log() throws Exception {
        // Issue 089: anonymous traffic can ask for any slug without limit; the slug must not reach the log (at WARN it
        // also
        // filled the rotating file until the security events were gone). Every level is captured, DEBUG included.
        String slug = "no-such-post-9c1e5a";
        Logger application = (Logger) LoggerFactory.getLogger("com.blog");
        Level previous = application.getLevel();
        ListAppender<ILoggingEvent> events = new ListAppender<>();
        events.start();
        application.setLevel(Level.DEBUG);
        application.addAppender(events);
        try {
            mockMvc.perform(get("/api/v1/posts/" + slug))
                    .andExpect(status().isNotFound())
                    .andExpect(jsonPath("$.error.code").value("POST_NOT_FOUND"));
            mockMvc.perform(get("/api/v1/posts/" + slug + "/redirect"))
                    .andExpect(status().isNotFound())
                    .andExpect(jsonPath("$.error.code").value("POST_NOT_FOUND"));
        } finally {
            application.detachAppender(events);
            application.setLevel(previous);
            events.stop();
        }

        assertThat(events.list).isNotEmpty();
        assertThat(events.list)
                .allSatisfy(event -> assertThat(event.getFormattedMessage()).doesNotContain(slug));
        assertThat(events.list).noneMatch(event -> event.getLevel().isGreaterOrEqual(Level.WARN));
    }
}
