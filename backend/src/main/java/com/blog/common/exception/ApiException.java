package com.blog.common.exception;

import java.util.Map;
import org.springframework.http.HttpStatus;

public class ApiException extends RuntimeException {

    private final ErrorCode code;
    private final HttpStatus status;
    private final Map<String, Object> details;

    public ApiException(ErrorCode code, HttpStatus status, String message) {
        this(code, status, message, null);
    }

    /**
     * @param details optional machine-readable facts that belong to the answer (for example {@code retryAfterSeconds}); null
     *                for none. Like the message, they never carry a value the caller sent or a secret.
     */
    public ApiException(ErrorCode code, HttpStatus status, String message, Map<String, Object> details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details == null ? null : Map.copyOf(details);
    }

    public ErrorCode getCode() {
        return code;
    }

    public HttpStatus getStatus() {
        return status;
    }

    public Map<String, Object> getDetails() {
        return details;
    }
}
