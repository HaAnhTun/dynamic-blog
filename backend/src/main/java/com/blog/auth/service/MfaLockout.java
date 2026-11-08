package com.blog.auth.service;

import java.time.Duration;
import java.time.Instant;

/**
 * The brake on wrong second-step codes of one account (reserve-then-verify, {@link MfaVerifier}). Pure arithmetic on the
 * counters stored in {@code user_mfa}: no clock of its own, no state, no I/O.
 *
 * <ul>
 *   <li>The first {@value #FREE_ATTEMPTS} consecutive wrong codes cost nothing but themselves.</li>
 *   <li>From the 5th on the second step answers 429 for {@code 30 s * 2^(n-5)}: 30, 60, 120, 240 and 480 seconds, then 15
 *       minutes (the cap, from the 10th failure on). While a lock is in the future even a correct code is refused,
 *       otherwise the delay would be no brake.</li>
 *   <li>At {@value #CEILING} consecutive failures the second step is frozen until an operator acts: every later attempt
 *       answers 403, a correct code included (NIST SP 800-63B 5.2.2 allows at most 100). A real {@code ADMIN_PASSWORD}
 *       change and the operator reset clear it; nothing else does.</li>
 * </ul>
 * The arithmetic of why this is enough: the window {-1, 0} has 2 valid values in 10^6, so one evaluated guess succeeds with
 * probability 2x10^-6; with 100 guesses at most, a person who holds only the password has about 1 in 5,000 per freeze.
 */
public final class MfaLockout {

    public static final int FREE_ATTEMPTS = 5;
    public static final int CEILING = 100;
    static final Duration FIRST_DELAY = Duration.ofSeconds(30);
    static final Duration MAX_DELAY = Duration.ofMinutes(15);
    private static final int LAST_DOUBLING = 9;

    private MfaLockout() {}

    /** What the stored counters say about the next attempt. */
    public enum State {
        /** Nothing stands in the way: the code is evaluated. */
        OPEN,
        /** A delay is running: 429, nothing is evaluated, no counter moves. */
        LOCKED,
        /** 100 consecutive failures: 403, nothing is evaluated, until the operator acts. */
        FROZEN
    }

    /**
     * What one more wrong code does to the counters.
     *
     * @param failedAttempts the new count of consecutive wrong codes
     * @param lockedUntil    when the next attempt may be evaluated; null for no delay
     * @param frozenNow      true exactly for the failure that reaches {@value #CEILING}: the one moment the operator is
     *                       told (ERROR, once)
     */
    public record Failure(int failedAttempts, Instant lockedUntil, boolean frozenNow) {}

    public static State stateOf(int failedAttempts, Instant lockedUntil, Instant now) {
        if (failedAttempts >= CEILING) {
            return State.FROZEN;
        }
        if (lockedUntil != null && lockedUntil.isAfter(now)) {
            return State.LOCKED;
        }
        return State.OPEN;
    }

    /** How long a lock lasts after the {@code failures}-th consecutive wrong code. */
    public static Duration delayAfter(int failures) {
        if (failures < FREE_ATTEMPTS) {
            return Duration.ZERO;
        }
        if (failures > LAST_DOUBLING) {
            return MAX_DELAY;
        }
        return FIRST_DELAY.multipliedBy(1L << (failures - FREE_ATTEMPTS));
    }

    /** The counters after one more wrong code, given the count before it. */
    public static Failure afterFailure(int failedBefore, Instant now) {
        int failed = failedBefore + 1;
        Duration delay = delayAfter(failed);
        Instant lockedUntil = delay.isZero() ? null : now.plus(delay);
        return new Failure(failed, lockedUntil, failed == CEILING);
    }

    /** Whole seconds until a lock ends, at least 1: what a client is told to wait. */
    public static long secondsLeft(Instant lockedUntil, Instant now) {
        long millis = Duration.between(now, lockedUntil).toMillis();
        return Math.max(1, (millis + 999) / 1000);
    }
}
