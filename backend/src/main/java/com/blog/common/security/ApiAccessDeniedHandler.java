package com.blog.common.security;

import com.blog.auth.support.AuthenticatedUser;
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
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.web.access.AccessDeniedHandler;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

@Component
@RequiredArgsConstructor
public class ApiAccessDeniedHandler implements AccessDeniedHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiAccessDeniedHandler.class);

    private final ObjectMapper objectMapper;

    @Override
    public void handle(
            HttpServletRequest request, HttpServletResponse response, AccessDeniedException accessDeniedException)
            throws IOException {
        String traceId = UUID.randomUUID().toString();
        // The caller by id, so a refusal can be attributed (never the address, the token or the role that was missing).
        // The path is still the caller's: a bounded prefix without the query (issue 089).
        log.warn(
                "Access denied method={} path={} actor={} traceId={}",
                LogText.method(request),
                LogText.path(request),
                AuthenticatedUser.actorForLog(),
                traceId);
        response.setStatus(HttpStatus.FORBIDDEN.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        // Deliberately does not say which role was required: the message is for a person
        // who hit the wrong button, not for something probing the authorization rules.
        objectMapper.writeValue(
                response.getOutputStream(),
                new ErrorResponse(new ErrorResponse.ErrorBody(
                        ErrorCode.FORBIDDEN.name(), "You do not have permission to do that", traceId)));
    }
}
