package com.blog.auth.oauth;

import com.blog.common.exception.ErrorCode;
import com.blog.common.response.ErrorResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.NestedExceptionUtils;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.web.authentication.AuthenticationFailureHandler;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpServerErrorException;
import org.springframework.web.client.ResourceAccessException;
import tools.jackson.databind.ObjectMapper;

/**
 * Every failed GitHub login becomes an {@code ErrorResponse} with a code, so Next can pick the message for the /login
 * page:
 *
 * <ul>
 *   <li>{@code access_denied} (the reader pressed "Cancel" on GitHub): 401 OAUTH_ACCESS_DENIED;</li>
 *   <li>no valid blob for this state, a mismatched state, or a callback that is not an authorize response: 401
 *       OAUTH_STATE_INVALID;</li>
 *   <li>GitHub cannot be reached (network error, timeout, 5xx, including while reading the response body) in the token
 *       exchange or profile read step: 502 OAUTH_PROVIDER_UNAVAILABLE;</li>
 *   <li>the account is suspended: 403 USER_SUSPENDED;</li>
 *   <li>everything else, including a wrong or already used code (GitHub answers HTTP 200 with an {@code error}), a
 *       mismatched redirect_uri, a malformed profile: 401 OAUTH_LOGIN_FAILED.</li>
 * </ul>
 *
 * <h2>Logging</h2>
 *
 * One WARN line: the blog's code, the OAuth error code and the class name of the root cause, and the traceId. Never
 * {@code error_description}, the code, the state or the exception message: Spring's message copies GitHub's error
 * description, and Spring's exception also keeps the login request (code, state). The OAuth error code comes from the
 * callback's {@code error} parameter, so anyone can type it, and it is only printed when it looks like an error code.
 * The blog's code field is named {@code error=}, not {@code code=}: the string {@code code=} in a log must always be a
 * sign that an OAuth code leaked.
 */
@Component
@RequiredArgsConstructor
public class GithubLoginFailureHandler implements AuthenticationFailureHandler {

    private static final Logger log = LoggerFactory.getLogger(GithubLoginFailureHandler.class);

    private static final Set<String> STATE_ERRORS =
            Set.of("authorization_request_not_found", "invalid_state_parameter", "invalid_request");
    private static final Set<String> PROVIDER_RESPONSE_ERRORS =
            Set.of("invalid_token_response", "invalid_user_info_response");
    private static final Pattern LOGGABLE_OAUTH_ERROR = Pattern.compile("[A-Za-z0-9_.-]{1,64}");

    private final ObjectMapper objectMapper;

    /** How a failure is answered. */
    record Outcome(ErrorCode code, HttpStatus status, String message) {}

    @Override
    public void onAuthenticationFailure(
            HttpServletRequest request, HttpServletResponse response, AuthenticationException exception)
            throws IOException {
        Outcome outcome = classify(exception);
        String traceId = UUID.randomUUID().toString();
        log.warn(
                "github login failed error={} oauthError={} cause={} traceId={}",
                outcome.code(),
                loggableOauthError(exception),
                NestedExceptionUtils.getMostSpecificCause(exception).getClass().getName(),
                traceId);

        response.setStatus(outcome.status().value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        objectMapper.writeValue(
                response.getOutputStream(),
                new ErrorResponse(new ErrorResponse.ErrorBody(outcome.code().name(), outcome.message(), traceId)));
    }

    static Outcome classify(AuthenticationException exception) {
        if (exception instanceof GithubOAuth2UserService.SuspendedAccountException) {
            return new Outcome(ErrorCode.USER_SUSPENDED, HttpStatus.FORBIDDEN, "This account is suspended");
        }
        // Set.of(...).contains(null) throws NullPointerException: an error without an OAuth code goes straight to the
        // end.
        String oauthError = oauthError(exception);
        if ("access_denied".equals(oauthError)) {
            return new Outcome(ErrorCode.OAUTH_ACCESS_DENIED, HttpStatus.UNAUTHORIZED, "GitHub sign-in was cancelled");
        }
        if (oauthError != null && STATE_ERRORS.contains(oauthError)) {
            return new Outcome(
                    ErrorCode.OAUTH_STATE_INVALID,
                    HttpStatus.UNAUTHORIZED,
                    "The sign-in request is missing, expired or already used");
        }
        if (oauthError != null && PROVIDER_RESPONSE_ERRORS.contains(oauthError) && providerUnreachable(exception)) {
            return new Outcome(
                    ErrorCode.OAUTH_PROVIDER_UNAVAILABLE, HttpStatus.BAD_GATEWAY, "GitHub could not be reached");
        }
        return new Outcome(ErrorCode.OAUTH_LOGIN_FAILED, HttpStatus.UNAUTHORIZED, "GitHub sign-in failed");
    }

    private static String oauthError(AuthenticationException exception) {
        return exception instanceof OAuth2AuthenticationException oauth
                ? oauth.getError().getErrorCode()
                : null;
    }

    private static String loggableOauthError(AuthenticationException exception) {
        String oauthError = oauthError(exception);
        if (oauthError == null) {
            return "-";
        }
        return LOGGABLE_OAUTH_ERROR.matcher(oauthError).matches() ? oauthError : "<not-loggable>";
    }

    /**
     * GitHub could not answer, shown by one of three signs somewhere in the cause chain:
     * <ul>
     *   <li>{@link ResourceAccessException}: a network error or timeout before any response arrived;</li>
     *   <li>{@link HttpServerErrorException}: GitHub answered 5xx;</li>
     *   <li>any {@link IOException}: a network error or timeout while reading the response BODY, when GitHub already
     *       sent the headers and then stopped, or the connection dropped midway (the JdkClientHttpRequest timer closes
     *       the body stream after 10 seconds). Spring wraps that error in a plain RestClientException, not a
     *       ResourceAccessException, and the original IO error sits deep below (through
     *       HttpMessageNotReadableException, then JacksonIOException).</li>
     * </ul>
     * A readable but wrong response (HTTP 200 with the error of an already used code) is not "could not answer": its
     * chain is RestClientException, HttpMessageNotReadableException, IllegalArgumentException, with no IO error.
     * Broken JSON is the same: Jackson 3 parse errors are RuntimeException, not IOException.
     */
    private static boolean providerUnreachable(Throwable exception) {
        Set<Throwable> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        for (Throwable cause = exception; cause != null && seen.add(cause); cause = cause.getCause()) {
            if (cause instanceof ResourceAccessException
                    || cause instanceof HttpServerErrorException
                    || cause instanceof IOException) {
                return true;
            }
        }
        return false;
    }
}
