package com.blog.common.limits;

import java.io.IOException;

/**
 * Thrown by the body stream of {@link RequestSizeLimitFilter} when a request that did not declare its length (chunked)
 * sends more bytes than its path allows. An {@link IOException}, so it comes out of any reader of the body; the message
 * handlers recognise it in the cause chain and answer 413.
 */
public class RequestBodyTooLargeException extends IOException {

    public RequestBodyTooLargeException(long limit) {
        super("The request body is larger than " + limit + " bytes");
    }

    /** @return true when this exception is the error or one of its causes (a reader wraps it in its own exception) */
    public static boolean isIn(Throwable error) {
        for (Throwable cause = error; cause != null; cause = cause.getCause() == cause ? null : cause.getCause()) {
            if (cause instanceof RequestBodyTooLargeException) {
                return true;
            }
        }
        return false;
    }
}
