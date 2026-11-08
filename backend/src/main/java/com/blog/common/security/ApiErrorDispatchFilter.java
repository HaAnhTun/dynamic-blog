package com.blog.common.security;

import com.blog.common.exception.ErrorCode;
import com.blog.common.response.ErrorResponse;
import jakarta.servlet.DispatcherType;
import jakarta.servlet.Filter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletRequest;
import jakarta.servlet.ServletResponse;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import tools.jackson.databind.ObjectMapper;

/**
 * Answers the error dispatch of the container with the API's own envelope and nothing else (issue 105).
 *
 * When Tomcat itself refuses a request before it reaches Spring (the {@code TRACE} method gets a 405 with an {@code Allow} header),
 * the container dispatches the request again to {@code /error}, as a new request without the caller's token. That second pass ran
 * through the security chain, found nobody signed in, and the answer became a 401 "Authentication required" for a request that was
 * malformed, not unauthenticated. Letting the second pass through the chain open instead would hand it to the dispatcher servlet,
 * whose default for {@code TRACE} echoes the request headers (cookies and tokens included) back as the body.
 *
 * So this filter, registered for the ERROR dispatch only and ahead of the security chain, writes the envelope itself with the
 * status the container chose, and never calls the chain. The message is generic: the container's own text names the method or the
 * path the caller chose. Registered by {@code ApiErrorDispatchConfig}. A request of the normal dispatch passes straight through.
 */
public final class ApiErrorDispatchFilter implements Filter {

    private static final Logger log = LoggerFactory.getLogger(ApiErrorDispatchFilter.class);

    private static final String NOT_FOUND_MESSAGE = "The requested endpoint does not exist";
    private static final String CLIENT_ERROR_MESSAGE = "The request could not be processed";
    private static final String SERVER_ERROR_MESSAGE = "An unexpected error occurred. Please try again later.";

    private final ObjectMapper objectMapper;

    public ApiErrorDispatchFilter(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public void doFilter(ServletRequest request, ServletResponse response, FilterChain chain)
            throws IOException, ServletException {
        if (request.getDispatcherType() != DispatcherType.ERROR || !(response instanceof HttpServletResponse http)) {
            chain.doFilter(request, response);
            return;
        }
        if (http.isCommitted()) {
            return;
        }
        int status = statusOf(request);
        String traceId = UUID.randomUUID().toString();
        ErrorCode code;
        String message;
        if (status == 404) {
            code = ErrorCode.ENDPOINT_NOT_FOUND;
            message = NOT_FOUND_MESSAGE;
        } else if (status >= 400 && status < 500) {
            code = ErrorCode.VALIDATION_ERROR;
            message = CLIENT_ERROR_MESSAGE;
        } else {
            code = ErrorCode.INTERNAL_ERROR;
            message = SERVER_ERROR_MESSAGE;
        }
        if (status >= 500) {
            log.warn("Container error status={} traceId={}", status, traceId);
        } else {
            // Anonymous traffic can cause these without limit: DEBUG, like the other expected client errors (issue
            // 089).
            log.debug("Container error status={} traceId={}", status, traceId);
        }
        http.resetBuffer();
        http.setStatus(status);
        http.setContentType(MediaType.APPLICATION_JSON_VALUE);
        objectMapper.writeValue(
                http.getOutputStream(), new ErrorResponse(new ErrorResponse.ErrorBody(code.name(), message, traceId)));
    }

    /** The status the container put on the original request; a missing or unreadable one counts as a server error. */
    private static int statusOf(ServletRequest request) {
        Object value = request.getAttribute(RequestDispatcher.ERROR_STATUS_CODE);
        return value instanceof Integer status && status >= 400 && status < 600 ? status : 500;
    }
}
