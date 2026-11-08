package com.blog.common.security;

import com.blog.common.exception.ErrorCode;
import com.blog.common.response.ErrorResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.web.firewall.RequestRejectedException;
import org.springframework.security.web.firewall.RequestRejectedHandler;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

/**
 * Answers a request that Spring Security's firewall refuses (a double slash, a matrix parameter such as {@code ;x=1}, an
 * encoded slash or dot segment, an HTTP method outside the allowed list such as TRACE) with the API's own 400 envelope.
 *
 * Without this handler the default one calls {@code response.sendError(400)}, the container then dispatches the request
 * again to {@code /error}, and that second dispatch passes through the security chain WITHOUT the caller's token: the
 * answer turned into a 401 "Authentication required" for a request that was malformed, not unauthenticated (issue 105). No
 * variant of those requests ever reached a handler, so this is about the response code and the body shape, not about
 * access. Writing the answer here keeps it a 400 whatever the caller sent, with no error dispatch.
 *
 * The log line carries the exception's class name and the trace id only: the rejected path is chosen by the caller and
 * the message of the exception repeats it.
 */
@Component
@RequiredArgsConstructor
public class ApiRequestRejectedHandler implements RequestRejectedHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiRequestRejectedHandler.class);

    private final ObjectMapper objectMapper;

    @Override
    public void handle(
            HttpServletRequest request, HttpServletResponse response, RequestRejectedException requestRejectedException)
            throws IOException {
        String traceId = UUID.randomUUID().toString();
        // Anonymous traffic can produce these without limit: DEBUG, like the other expected client errors (issue 089).
        log.debug(
                "Request rejected by the firewall reason={} traceId={}",
                requestRejectedException.getClass().getSimpleName(),
                traceId);
        response.setStatus(HttpStatus.BAD_REQUEST.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        objectMapper.writeValue(
                response.getOutputStream(),
                new ErrorResponse(
                        new ErrorResponse.ErrorBody(ErrorCode.VALIDATION_ERROR.name(), "Malformed request", traceId)));
    }
}
