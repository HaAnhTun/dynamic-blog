package com.blog.common.exception;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.limits.RequestBodyTooLargeException;
import com.blog.common.response.ErrorResponse;
import com.blog.common.text.UserText;
import com.blog.common.util.LogText;
import com.blog.common.util.LogThrottle;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import java.util.function.LongSupplier;
import org.apache.tomcat.util.http.InvalidParameterException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.validation.FieldError;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.multipart.MaxUploadSizeExceededException;

@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    private static final String GENERIC_INTERNAL_ERROR_MESSAGE =
            "An unexpected error occurred. Please try again later.";

    /** The keys are error codes, a small fixed set; 32 is more than the codes that answer 429. */
    private static final int THROTTLE_KEYS = 32;

    /** Not an error code, so it cannot collide with the keys of the 429 lines. */
    private static final String UPLOAD_TOO_LARGE_KEY = "multipart-too-large";

    private final LogThrottle rateLimitLines;

    public GlobalExceptionHandler() {
        this(System::nanoTime);
    }

    GlobalExceptionHandler(LongSupplier nanoClock) {
        this.rateLimitLines = new LogThrottle(Duration.ofMinutes(1), THROTTLE_KEYS, nanoClock);
    }

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ErrorResponse> handleApiException(ApiException ex) {
        String traceId = newTraceId();
        logApiException(ex, traceId);
        return toResponse(ex.getStatus(), ex.getCode(), ex.getMessage(), traceId, ex.getDetails());
    }

    /**
     * What an {@link ApiException} writes to the log depends on who can cause it.
     *
     * A 4xx that anonymous traffic can produce at will (an unknown slug, a malformed request, a conflict) is DEBUG and
     * carries the code and the trace id only: the message of such an answer often repeats what the caller sent (a slug),
     * and nothing limits how many of them arrive, so at WARN they would fill the rotating log until the security events
     * (refresh-token reuse, failed sign-ins) had been pushed out of it (issue 089). A 401 or 403 needs a missing or refused
     * credential or a role that is too low, so it stays at WARN, still without the message. A 429 is what a crowd gets once
     * it is past a ceiling, one more for every further request, so it is WARN once per minute and error code, with the
     * number of similar answers left out since the last line, and DEBUG for the repeats. A 5xx is the server's own fault,
     * written by the server, and keeps its message.
     *
     * The security events themselves are logged where they happen (AuthService, RefreshTokenService, MfaVerifier ...),
     * not here.
     */
    private void logApiException(ApiException ex, String traceId) {
        int status = ex.getStatus().value();
        if (status >= 500) {
            log.warn(
                    "ApiException code={} status={} actor={} message={} traceId={}",
                    ex.getCode(),
                    ex.getStatus(),
                    AuthenticatedUser.actorForLog(),
                    UserText.forLog(ex.getMessage()),
                    traceId);
        } else if (status == 429) {
            logRateLimited(ex, traceId);
        } else if (status == 401 || status == 403) {
            log.warn(
                    "ApiException code={} status={} actor={} traceId={}",
                    ex.getCode(),
                    ex.getStatus(),
                    AuthenticatedUser.actorForLog(),
                    traceId);
        } else {
            log.debug("ApiException code={} status={} traceId={}", ex.getCode(), ex.getStatus(), traceId);
        }
    }

    private void logRateLimited(ApiException ex, String traceId) {
        int leftOut = rateLimitLines.record(ex.getCode().name());
        if (leftOut == LogThrottle.REPEAT) {
            log.debug("ApiException code={} status={} traceId={}", ex.getCode(), ex.getStatus(), traceId);
        } else if (leftOut == 0) {
            log.warn(
                    "ApiException code={} status={} actor={} traceId={}",
                    ex.getCode(),
                    ex.getStatus(),
                    AuthenticatedUser.actorForLog(),
                    traceId);
        } else {
            log.warn(
                    "ApiException code={} status={} actor={} traceId={} ({} similar answers left out since the last line)",
                    ex.getCode(),
                    ex.getStatus(),
                    AuthenticatedUser.actorForLog(),
                    traceId,
                    leftOut);
        }
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> handleValidation(MethodArgumentNotValidException ex) {
        String message = ex.getBindingResult().getFieldErrors().stream()
                .findFirst()
                .map(FieldError::getDefaultMessage)
                .orElse("Validation failed");
        String traceId = newTraceId();
        log.debug("Validation failed message={} traceId={}", UserText.forLog(message), traceId);
        return toResponse(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, message, traceId);
    }

    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<ErrorResponse> handleTypeMismatch(MethodArgumentTypeMismatchException ex) {
        String message = "Invalid value for parameter '" + ex.getName() + "'";
        String traceId = newTraceId();
        log.debug("Type mismatch parameter={} traceId={}", ex.getName(), traceId);
        return toResponse(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, message, traceId);
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ErrorResponse> handleMessageNotReadable(HttpMessageNotReadableException ex) {
        String traceId = newTraceId();
        if (RequestBodyTooLargeException.isIn(ex)) {
            return tooLarge(traceId);
        }
        log.debug("Malformed request body traceId={}", traceId);
        return toResponse(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, "Malformed request body", traceId);
    }

    /**
     * The body stream of {@code RequestSizeLimitFilter} stopped a chunked request that went past its ceiling. The reader
     * (Jackson) wraps the {@link RequestBodyTooLargeException}, so it is looked for in the cause chain. Same answer as the
     * filter gives for a request that declares its length: 413 with {@code VALIDATION_ERROR}.
     */
    private ResponseEntity<ErrorResponse> tooLarge(String traceId) {
        log.debug("Request body over the limit traceId={}", traceId);
        return toResponse(
                HttpStatus.CONTENT_TOO_LARGE, ErrorCode.VALIDATION_ERROR, "The request body is too large", traceId);
    }

    /**
     * Tomcat cannot read the parameters (a bad % escape such as {@code %FF}, too many parameters) and throws when
     * Spring asks for a parameter. A fault of the request, not of the server. The message is not logged: it copies the
     * value the reader typed.
     */
    @ExceptionHandler(InvalidParameterException.class)
    public ResponseEntity<ErrorResponse> handleInvalidParameter(InvalidParameterException ex) {
        String traceId = newTraceId();
        log.debug("Unreadable request parameters traceId={}", traceId);
        return toResponse(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR, "Malformed request parameters", traceId);
    }

    /**
     * A part exceeds {@code spring.servlet.multipart.max-file-size} (or the whole request exceeds max-request-size):
     * Spring throws while parsing the multipart, even before the controller. Without this handler it would still be a
     * 413 but through the framework error branch with the generic code VALIDATION_ERROR; here it carries the same
     * MEDIA_TOO_LARGE code as the limit checked in code (MediaService), so the admin UI says "image too large" no matter
     * which layer blocked it.
     */
    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<ErrorResponse> handleUploadTooLarge(MaxUploadSizeExceededException ex) {
        String traceId = newTraceId();
        logUploadTooLarge(traceId);
        return toResponse(
                HttpStatus.CONTENT_TOO_LARGE,
                ErrorCode.MEDIA_TOO_LARGE,
                "The uploaded file exceeds the size limit",
                traceId);
    }

    /**
     * WARN once a minute with the number of similar refusals left out, DEBUG for the repeats: a signed-in account with an
     * oversized body can repeat this as often as it likes (issue 089). The key is a fixed word, not the caller's text.
     */
    private void logUploadTooLarge(String traceId) {
        int leftOut = rateLimitLines.record(UPLOAD_TOO_LARGE_KEY);
        if (leftOut == LogThrottle.REPEAT) {
            log.debug("Upload exceeded the multipart size limit traceId={}", traceId);
        } else if (leftOut == 0) {
            log.warn("Upload exceeded the multipart size limit traceId={}", traceId);
        } else {
            log.warn(
                    "Upload exceeded the multipart size limit traceId={} ({} similar answers left out since the last line)",
                    traceId,
                    leftOut);
        }
    }

    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<ErrorResponse> handleDataIntegrityViolation(DataIntegrityViolationException ex) {
        // The response message is deliberately generic: Postgres constraint violations name
        // indexes and columns, and this response reaches unauthenticated callers. The full
        // exception is still logged at ERROR so a genuine FK/NOT NULL bug leaves a stack trace.
        String traceId = newTraceId();
        log.error("Data integrity violation traceId={}", traceId, ex);
        return toResponse(
                HttpStatus.CONFLICT, ErrorCode.RESOURCE_CONFLICT, "The request conflicts with existing data", traceId);
    }

    /**
     * `@PreAuthorize` denials are thrown from inside the controller method invocation
     * (the AOP proxy sits around the handler method itself), so they are resolved by
     * Spring MVC's `@ExceptionHandler` machinery rather than by Spring Security's
     * `ExceptionTranslationFilter` / `AccessDeniedHandler` — that filter only ever sees
     * exceptions thrown from `authorizeHttpRequests` rules, which fail before the request
     * reaches the DispatcherServlet at all. Without this handler, `AuthorizationDeniedException`
     * (a subclass of `AccessDeniedException`) falls through to the catch-all below and comes
     * back as a 500, which is exactly backwards for a caller who is authenticated but simply
     * lacks the role. The body matches `ApiAccessDeniedHandler` so a denial reads the same
     * whether it was stopped by a URL rule or by a method annotation.
     */
    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<ErrorResponse> handleAccessDenied(AccessDeniedException ex, HttpServletRequest request) {
        String traceId = newTraceId();
        // The caller by id, like ApiAccessDeniedHandler: a denial by an ownership rule is attributable too.
        log.warn(
                "Access denied method={} path={} actor={} message={} traceId={}",
                LogText.method(request),
                LogText.path(request),
                AuthenticatedUser.actorForLog(),
                UserText.forLog(ex.getMessage()),
                traceId);
        return toResponse(HttpStatus.FORBIDDEN, ErrorCode.FORBIDDEN, "You do not have permission to do that", traceId);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleUnexpected(Exception ex) {
        // Because this @RestControllerAdvice declares no selectors, it intercepts framework-owned
        // conditions too (unmapped routes, wrong HTTP method, unsupported media type, ...), not
        // only exceptions thrown from our own controller methods. Those all implement Spring's
        // ErrorResponse and already carry the right 4xx status - honour it here instead of letting
        // a typo'd URL or a bare method-not-allowed fall through to the 500 branch below, which
        // would fabricate an "internal error" complete with a stack trace at ERROR.
        if (ex instanceof org.springframework.web.ErrorResponse frameworkError
                && frameworkError.getStatusCode().is4xxClientError()) {
            return handleFrameworkClientError(ex, frameworkError.getStatusCode());
        }

        // Never surface ex.getMessage() here: this is the catch-all for exceptions no other
        // handler recognised, and the response reaches unauthenticated callers.
        String traceId = newTraceId();
        if (RequestBodyTooLargeException.isIn(ex)) {
            return tooLarge(traceId);
        }
        log.error("Unhandled exception type={} traceId={}", ex.getClass().getName(), traceId, ex);
        return toResponse(
                HttpStatus.INTERNAL_SERVER_ERROR, ErrorCode.INTERNAL_ERROR, GENERIC_INTERNAL_ERROR_MESSAGE, traceId);
    }

    private ResponseEntity<ErrorResponse> handleFrameworkClientError(Exception ex, HttpStatusCode statusCode) {
        // ENDPOINT_NOT_FOUND is distinct from the domain NOT_FOUND codes (POST_NOT_FOUND etc.):
        // this branch only fires for requests that never reached a controller method at all
        // (unmapped route, wrong HTTP method, unsupported media type, ...), so VALIDATION_ERROR
        // covers the rest of those cases well enough without a code per framework exception type.
        boolean notFound = statusCode.value() == HttpStatus.NOT_FOUND.value();
        ErrorCode code = notFound ? ErrorCode.ENDPOINT_NOT_FOUND : ErrorCode.VALIDATION_ERROR;
        String message = notFound ? "The requested endpoint does not exist" : "The request could not be processed";
        String traceId = newTraceId();
        // DEBUG: any scanner can produce these (unmapped paths, wrong methods) without limit, see logApiException.
        log.debug(
                "Framework client error type={} status={} traceId={}",
                ex.getClass().getName(),
                statusCode,
                traceId);
        return toResponse(statusCode, code, message, traceId);
    }

    private static String newTraceId() {
        return UUID.randomUUID().toString();
    }

    /**
     * The JSON Content-Type is preset, so Spring skips Accept negotiation when writing the error body. Since
     * /api/v1/media exists, a valid request may accept only images (Accept: image/png, with no wildcard type); if
     * negotiation decided, JSON could not be written, the original exception would escape the handler and a 404 would
     * become a 500. An error body that is always JSON is the API's contract, and RFC 9110 allows an error response that
     * does not match Accept.
     */
    private static ResponseEntity<ErrorResponse> toResponse(
            HttpStatusCode status, ErrorCode code, String message, String traceId) {
        return toResponse(status, code, message, traceId, null);
    }

    private static ResponseEntity<ErrorResponse> toResponse(
            HttpStatusCode status, ErrorCode code, String message, String traceId, Map<String, Object> details) {
        ErrorResponse body = new ErrorResponse(new ErrorResponse.ErrorBody(code.name(), message, traceId, details));
        return ResponseEntity.status(status)
                .contentType(MediaType.APPLICATION_JSON)
                .body(body);
    }
}
