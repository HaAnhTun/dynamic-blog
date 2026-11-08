package com.blog.common.ratelimit;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.time.Duration;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * Limits how many login password checks run at the same time, for the whole JVM.
 *
 * Each check is one Argon2id run with 19 MiB of memory (SecurityConfig.passwordEncoder), even for an email that does
 * not exist (AuthService compares against a fake hash so an unknown email does not answer faster). Without a limit, 200
 * Tomcat threads would need about 3.8 GiB, inside a heap of around 700 MiB: a few dozen parallel requests from a
 * {@code curl} loop are enough to cause an OOM. Here only {@code app.rate-limit.login.concurrent} checks (default 2) run
 * at once; the others wait for their turn, at most {@code app.rate-limit.login.max-wait} (default 5 seconds), after
 * which they get 429 {@code RATE_LIMITED}. Waiting costs no Argon2: the thread just sits still and holds no 19 MiB.
 *
 * A fair semaphore, like MediaService: the longest waiter goes first, and a burst of new requests cannot cut in until
 * the site owner's turn times out. The permit is always returned in {@code finally}, even when the check throws.
 *
 * It does not count wrong attempts per email and does not lock accounts: anyone who knows the site owner's email could
 * lock the site owner out. Attempts are counted per client address before they get here (AuthService, bucket
 * {@link RateLimiter#LOGIN_CLIENT}, with the address Next forwards or the socket address) and in Next's login route.
 */
@Component
public class LoginConcurrencyLimiter {

    private final Semaphore permits;
    private final long maxWaitNanos;

    @Autowired
    public LoginConcurrencyLimiter(RateLimitProperties properties) {
        this(properties.login().concurrent(), properties.login().maxWait());
    }

    /** For tests: a given number of permits and wait time, bypassing configuration. */
    public LoginConcurrencyLimiter(int concurrent, Duration maxWait) {
        this.permits = new Semaphore(concurrent, true);
        this.maxWaitNanos = maxWait.toNanos();
    }

    /**
     * Runs one password check when its turn comes.
     *
     * @param passwordCheck the check, usually {@code passwordEncoder.matches(...)}
     * @return the result of the check
     * @throws ApiException 429 {@code RATE_LIMITED} when it waited longer than {@code max-wait} without getting its turn
     *                      (the check then does not run); the message mentions no account
     */
    public boolean verify(BooleanSupplier passwordCheck) {
        return run(passwordCheck::getAsBoolean);
    }

    /**
     * Runs any other Argon2 work (hashing a password again after a correct sign-in) when its turn comes, under the same
     * permits as {@link #verify}.
     *
     * @throws ApiException 429 {@code RATE_LIMITED} when it waited longer than {@code max-wait} (the work then does not run)
     */
    public <T> T run(Supplier<T> work) {
        acquire();
        try {
            return work.get();
        } finally {
            permits.release();
        }
    }

    /** The number of free permits; for tests. */
    int availablePermits() {
        return permits.availablePermits();
    }

    private void acquire() {
        boolean acquired;
        try {
            // The timed tryAcquire honours fairness; the no-argument tryAcquire() does not.
            acquired = permits.tryAcquire(maxWaitNanos, TimeUnit.NANOSECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            acquired = false;
        }
        if (!acquired) {
            throw new ApiException(
                    ErrorCode.RATE_LIMITED,
                    HttpStatus.TOO_MANY_REQUESTS,
                    "Too many sign-in attempts are being checked right now; try again in a moment");
        }
    }
}
