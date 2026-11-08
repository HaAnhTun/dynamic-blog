package com.blog.common.util;

import java.time.Duration;
import java.util.HashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/**
 * Lets a log line that a caller can repeat at will through once per window and key, so that a flood of it cannot rotate the
 * rotating log (3 x 10 MB in the Compose file) past the security events written before it (issue 089).
 *
 * {@link #record(String)} says what to do with one event: {@link #REPEAT} when an event of the same key was already logged in the
 * window (log it at DEBUG, or not at all), otherwise the number of events of that key that were left out since the last logged one
 * (0 for the first ever). The line written then can say "N similar left out", so the volume stays visible. The count of a
 * window that no further event follows is never written.
 *
 * Memory is bounded: at most {@code maxKeys} keys are remembered, and a key that does not fit is always logged (the safe side for a
 * security line). Keys must come from a small set (an error code, an exception class), never from the caller.
 */
public final class LogThrottle {

    /** The event is a repeat inside the window: do not write it at WARN. */
    public static final int REPEAT = -1;

    private final long windowNanos;
    private final int maxKeys;
    private final LongSupplier nanoClock;
    private final Map<String, State> states = new HashMap<>();

    public LogThrottle(Duration window, int maxKeys) {
        this(window, maxKeys, System::nanoTime);
    }

    public LogThrottle(Duration window, int maxKeys, LongSupplier nanoClock) {
        this.windowNanos = window.toNanos();
        this.maxKeys = maxKeys;
        this.nanoClock = nanoClock;
    }

    /** @return {@link #REPEAT}, or how many events of this key were left out since the last one that was logged */
    public synchronized int record(String key) {
        long now = nanoClock.getAsLong();
        State state = states.get(key);
        if (state == null) {
            if (states.size() >= maxKeys) {
                states.values().removeIf(other -> now - other.windowStart >= windowNanos);
                if (states.size() >= maxKeys) {
                    return 0;
                }
            }
            states.put(key, new State(now));
            return 0;
        }
        if (now - state.windowStart >= windowNanos) {
            int leftOut = state.leftOut;
            state.windowStart = now;
            state.leftOut = 0;
            return leftOut;
        }
        state.leftOut++;
        return REPEAT;
    }

    /** The number of keys remembered; for the test of the bound. */
    synchronized int trackedKeys() {
        return states.size();
    }

    private static final class State {
        long windowStart;
        int leftOut;

        State(long windowStart) {
            this.windowStart = windowStart;
        }
    }
}
