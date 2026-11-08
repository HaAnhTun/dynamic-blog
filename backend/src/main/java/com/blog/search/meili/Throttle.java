package com.blog.search.meili;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;

/**
 * Lets through at most one call per interval, thread-safe: one Meilisearch error log line per minute, or one attempt to
 * recreate the keys. The first call always passes.
 */
public final class Throttle {

    private final long intervalNanos;
    private final LongSupplier nanoClock;
    private final AtomicLong last;

    public Throttle(Duration interval) {
        this(interval, System::nanoTime);
    }

    Throttle(Duration interval, LongSupplier nanoClock) {
        this.intervalNanos = interval.toNanos();
        this.nanoClock = nanoClock;
        this.last = new AtomicLong(nanoClock.getAsLong() - intervalNanos);
    }

    public boolean tryAcquire() {
        long now = nanoClock.getAsLong();
        long previous = last.get();
        return now - previous >= intervalNanos && last.compareAndSet(previous, now);
    }
}
