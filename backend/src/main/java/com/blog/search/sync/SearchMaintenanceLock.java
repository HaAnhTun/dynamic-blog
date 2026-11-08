package com.blog.search.sync;

import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.stereotype.Component;

/**
 * One index maintenance job at a time: an admin reindex or a scheduled reconcile pass. It does not wait: whoever cannot
 * take it gets 409 (reindex) or skips the pass (schedule). In memory, like RateLimiter: one backend instance runs.
 */
@Component
public class SearchMaintenanceLock {

    private final AtomicBoolean held = new AtomicBoolean();

    public boolean tryAcquire() {
        return held.compareAndSet(false, true);
    }

    public void release() {
        held.set(false);
    }

    public boolean held() {
        return held.get();
    }
}
