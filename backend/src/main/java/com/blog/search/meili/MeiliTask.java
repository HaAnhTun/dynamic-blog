package com.blog.search.meili;

/**
 * A Meilisearch task ({@code GET /tasks/{uid}}).
 *
 * @param status    enqueued, processing, succeeded, failed or canceled
 * @param errorCode {@code error.code} when failed, null otherwise
 */
public record MeiliTask(long uid, String status, String errorCode) {

    public boolean finished() {
        return "succeeded".equals(status) || "failed".equals(status) || "canceled".equals(status);
    }
}
