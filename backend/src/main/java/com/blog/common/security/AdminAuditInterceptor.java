package com.blog.common.security;

import com.blog.auth.support.AuthenticatedUser;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * One line for every request that can change something under {@code /api/v1/admin/**}: who (the account id from the token,
 * never an address or the token), what (the method and the path, the handler) and how it ended (the status). It runs after
 * the request, so a refusal (403), a bad request (400) and a success (2xx) are all on record, and an administrator's or an
 * author's write is attributable without every service having to remember to say so. Reads are not logged here.
 *
 * Only the path is logged, never the query string or a body: an admin path holds ids and slugs, but a query can hold a
 * search text. A denial by the URL rules never reaches the dispatcher; {@link ApiAccessDeniedHandler} logs that one.
 */
public class AdminAuditInterceptor implements HandlerInterceptor {

    private static final Logger log = LoggerFactory.getLogger(AdminAuditInterceptor.class);

    private static final Set<String> READS = Set.of("GET", "HEAD", "OPTIONS", "TRACE");

    @Override
    public void afterCompletion(
            HttpServletRequest request, HttpServletResponse response, Object handler, Exception exception) {
        if (READS.contains(request.getMethod())) {
            return;
        }
        log.info(
                "admin request actor={} method={} path={} handler={} status={}",
                AuthenticatedUser.actorForLog(),
                request.getMethod(),
                request.getRequestURI(),
                handler instanceof HandlerMethod method
                        ? method.getBeanType().getSimpleName() + "."
                                + method.getMethod().getName()
                        : "none",
                response.getStatus());
    }
}
