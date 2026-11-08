package com.blog.common.security;

import com.blog.common.exception.ErrorCode;
import com.blog.common.response.ErrorResponse;
import com.blog.common.util.LogText;
import com.blog.common.util.LogThrottle;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Duration;
import java.util.UUID;
import java.util.function.LongSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.InsufficientAuthenticationException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

/**
 * Without this, a 401 is the only response in the whole API with a different shape:
 * Spring Security writes its own body and adds WWW-Authenticate, which makes a browser
 * open a credential dialog against a JSON endpoint.
 */
@Component
public class ApiAuthenticationEntryPoint implements AuthenticationEntryPoint {

    private static final Logger log = LoggerFactory.getLogger(ApiAuthenticationEntryPoint.class);

    /** The keys are exception class names (the decoder's and the filter's), a small fixed set; 32 is more than exist. */
    private static final int THROTTLE_KEYS = 32;

    private final ObjectMapper objectMapper;
    private final LogThrottle refusedLines;

    @Autowired
    public ApiAuthenticationEntryPoint(ObjectMapper objectMapper) {
        this(objectMapper, System::nanoTime);
    }

    ApiAuthenticationEntryPoint(ObjectMapper objectMapper, LongSupplier nanoClock) {
        this.objectMapper = objectMapper;
        this.refusedLines = new LogThrottle(Duration.ofMinutes(1), THROTTLE_KEYS, nanoClock);
    }

    @Override
    public void commence(
            HttpServletRequest request, HttpServletResponse response, AuthenticationException authException)
            throws IOException {
        String traceId = UUID.randomUUID().toString();
        // The exception's CLASS NAME, never its message: for an expired token the message is
        // the decoder's own text, which carries the expiry instant and so the server's clock
        // and the token's lifetime. The Authorization header is never logged either - a log
        // line is the one place a token fragment outlives rotation. The path is a bounded
        // prefix without the query (LogText): the caller chose it.
        if (authException instanceof InsufficientAuthenticationException) {
            // No credential at all, the cheapest request there is: anyone can send these without limit, so they are
            // DEBUG, like the other expected client errors (issue 089). A token that was sent and refused stays at
            // WARN.
            log.debug(
                    "Unauthenticated request method={} path={} reason={} traceId={}",
                    LogText.method(request),
                    LogText.path(request),
                    authException.getClass().getSimpleName(),
                    traceId);
        } else {
            logRefusedCredential(request, authException, traceId);
        }
        response.setStatus(HttpStatus.UNAUTHORIZED.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        objectMapper.writeValue(
                response.getOutputStream(),
                new ErrorResponse(new ErrorResponse.ErrorBody(
                        ErrorCode.UNAUTHENTICATED.name(), "Authentication required", traceId)));
    }

    /**
     * A token that was sent and refused is WARN, but only once a minute per reason, with the number of similar refusals left
     * out since the last line (and DEBUG for the repeats). Anyone can send {@code Authorization: Bearer <anything>} without
     * limit, so a line per request would let anonymous traffic rotate the audit lines out of the log (issue 089). The key is
     * the exception class, never anything the caller wrote.
     */
    private void logRefusedCredential(
            HttpServletRequest request, AuthenticationException authException, String traceId) {
        String reason = authException.getClass().getSimpleName();
        int leftOut = refusedLines.record(reason);
        if (leftOut == LogThrottle.REPEAT) {
            log.debug(
                    "Unauthenticated request method={} path={} reason={} traceId={}",
                    LogText.method(request),
                    LogText.path(request),
                    reason,
                    traceId);
        } else if (leftOut == 0) {
            log.warn(
                    "Unauthenticated request method={} path={} reason={} traceId={}",
                    LogText.method(request),
                    LogText.path(request),
                    reason,
                    traceId);
        } else {
            log.warn(
                    "Unauthenticated request method={} path={} reason={} traceId={} ({} similar refusals left out since the last line)",
                    LogText.method(request),
                    LogText.path(request),
                    reason,
                    traceId,
                    leftOut);
        }
    }
}
