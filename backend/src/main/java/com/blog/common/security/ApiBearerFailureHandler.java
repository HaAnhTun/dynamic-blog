package com.blog.common.security;

import com.blog.common.exception.ErrorCode;
import com.blog.common.response.ErrorResponse;
import com.blog.common.util.LogText;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.AuthenticationServiceException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.web.authentication.AuthenticationFailureHandler;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

/**
 * Authentication failures of the bearer filter. If access cannot be verified because the DB failed
 * (CurrentAccessJwtConverter), the answer is 503 with an error envelope; Spring's default rethrows that error out of
 * the filter chain. Every other failure is still the entry point's 401.
 */
@Component
@RequiredArgsConstructor
public class ApiBearerFailureHandler implements AuthenticationFailureHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiBearerFailureHandler.class);

    private final ApiAuthenticationEntryPoint entryPoint;
    private final ObjectMapper objectMapper;

    @Override
    public void onAuthenticationFailure(
            HttpServletRequest request, HttpServletResponse response, AuthenticationException exception)
            throws IOException {
        if (!(exception instanceof AuthenticationServiceException)) {
            entryPoint.commence(request, response, exception);
            return;
        }
        String traceId = UUID.randomUUID().toString();
        log.warn(
                "Could not verify access method={} path={} traceId={}",
                LogText.method(request),
                LogText.path(request),
                traceId);
        response.setStatus(HttpStatus.SERVICE_UNAVAILABLE.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        objectMapper.writeValue(
                response.getOutputStream(),
                new ErrorResponse(new ErrorResponse.ErrorBody(
                        ErrorCode.INTERNAL_ERROR.name(),
                        "Could not verify access right now; try again shortly",
                        traceId)));
    }
}
