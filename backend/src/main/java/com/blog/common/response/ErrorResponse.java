package com.blog.common.response;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Map;

public record ErrorResponse(ErrorBody error) {

    /**
     * @param details optional facts about the failure, present only when the answer has some (the wait of a rate limit);
     *                absent from the JSON otherwise, so every other error body is unchanged
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record ErrorBody(String code, String message, String traceId, Map<String, Object> details) {

        public ErrorBody(String code, String message, String traceId) {
            this(code, message, traceId, null);
        }
    }
}
