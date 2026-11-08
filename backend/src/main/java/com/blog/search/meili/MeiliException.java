package com.blog.search.meili;

import java.util.regex.Pattern;

/**
 * Meilisearch could not do what was asked. Carries only a safe code: the message is a fixed sentence, never the error body
 * of Meilisearch (it echoes the filter and the query), the query or a key. The original exception is not kept either: its
 * message may echo the error body. For search, every code makes {@code GET /api/v1/search} return the Postgres result, degraded.
 */
public class MeiliException extends RuntimeException {

    private static final Pattern ENGINE_CODE = Pattern.compile("[a-z_]{1,64}");

    public enum Code {
        /** Missing {@code MEILI_URL} or {@code MEILI_MASTER_KEY}. */
        NOT_CONFIGURED(true),
        CONNECTION_FAILED(true),
        TIMEOUT(true),
        /** 503, for example the search queue is full ({@code too_many_search_requests}). */
        UNAVAILABLE(true),
        SERVER_ERROR(true),
        INDEX_NOT_FOUND(true),
        /** Wrong, missing or insufficiently privileged key (401, 403). */
        INVALID_API_KEY(true),
        /** A filter built by the backend itself was rejected: a configuration error (settings not applied), not a user error. */
        INVALID_SEARCH_FILTER(true),
        /** The response body is unreadable or lacks a field. */
        INVALID_RESPONSE(true),
        /** Other 4xx, for example {@code invalid_document_id}: a fault of one batch, not of the whole engine. */
        REQUEST_REJECTED(false),
        TASK_FAILED(false),
        TASK_CANCELED(false),
        /** The task was not finished when the wait expired; it may still finish later. */
        TASK_TIMEOUT(true);

        private final boolean engineWide;

        Code(boolean engineWide) {
            this.engineWide = engineWide;
        }

        /** A fault of the whole engine (the worker stops the whole batch), not of one document or of this task. */
        public boolean engineWide() {
            return engineWide;
        }
    }

    private final Code code;
    private final String engineCode;

    public MeiliException(Code code) {
        this(code, null);
    }

    /** @param engineCode Meilisearch error code ({@code error.code}); kept only when it has the shape of a code, never a message */
    public MeiliException(Code code, String engineCode) {
        super(
                engineCode != null && ENGINE_CODE.matcher(engineCode).matches()
                        ? "Meilisearch " + code + " (" + engineCode + ")"
                        : "Meilisearch " + code);
        this.code = code;
        this.engineCode = engineCode != null && ENGINE_CODE.matcher(engineCode).matches() ? engineCode : null;
    }

    public Code code() {
        return code;
    }

    /** Meilisearch {@code error.code}, for example {@code index_not_found}; null when absent. */
    public String engineCode() {
        return engineCode;
    }
}
