package com.blog.common.ratelimit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

/**
 * Limits how many password checks of a login run at the same time: returns exactly the result of the check, always returns the permit
 * (even when the check throws), never lets more than N run at once, and when the wait is too long gives 429 RATE_LIMITED without
 * running any check.
 */
class LoginConcurrencyLimiterTest {

    @Test
    void returns_exact_result_of_check_and_returns_permit() {
        LoginConcurrencyLimiter limiter = new LoginConcurrencyLimiter(2, Duration.ofSeconds(1));

        assertThat(limiter.verify(() -> true)).isTrue();
        assertThat(limiter.verify(() -> false)).isFalse();
        assertThat(limiter.availablePermits()).isEqualTo(2);
    }

    @Test
    void run_returns_the_value_of_other_Argon2_work_under_the_same_permits() {
        LoginConcurrencyLimiter limiter = new LoginConcurrencyLimiter(1, Duration.ofMillis(200));

        assertThat(limiter.run(() -> "a fresh hash")).isEqualTo("a fresh hash");
        assertThat(limiter.availablePermits()).isEqualTo(1);
        assertThatThrownBy(() -> limiter.run(() -> {
                    throw new IllegalStateException("out of memory");
                }))
                .isInstanceOf(IllegalStateException.class);
        assertThat(limiter.availablePermits()).isEqualTo(1);
    }

    @Test
    void check_throwing_propagates_error_and_permit_is_still_returned() {
        LoginConcurrencyLimiter limiter = new LoginConcurrencyLimiter(1, Duration.ofMillis(200));

        assertThatThrownBy(() -> limiter.verify(() -> {
                    throw new IllegalStateException("broken hash");
                }))
                .isInstanceOf(IllegalStateException.class)
                .hasMessage("broken hash");

        assertThat(limiter.availablePermits()).isEqualTo(1);
        // Control: the permit was truly returned, so the next one enters immediately instead of waiting out the timeout
        // and then getting 429.
        assertThat(limiter.verify(() -> true)).isTrue();
    }

    @Test
    void no_permit_within_wait_time_gives_429_RATE_LIMITED_and_runs_no_check() throws Exception {
        LoginConcurrencyLimiter limiter = new LoginConcurrencyLimiter(1, Duration.ofMillis(200));
        CountDownLatch holding = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            // One running check holds the only permit.
            Future<Boolean> slow = pool.submit(() -> limiter.verify(() -> {
                holding.countDown();
                await(release);
                return true;
            }));
            assertThat(holding.await(5, TimeUnit.SECONDS)).isTrue();

            AtomicBoolean ran = new AtomicBoolean();
            long started = System.nanoTime();
            assertThatThrownBy(() -> limiter.verify(() -> ran.getAndSet(true)))
                    .isInstanceOf(ApiException.class)
                    .hasFieldOrPropertyWithValue("code", ErrorCode.RATE_LIMITED)
                    .hasFieldOrPropertyWithValue("status", HttpStatus.TOO_MANY_REQUESTS);
            // It waited the full wait time rather than being rejected at once, and no Argon2 ran.
            assertThat(Duration.ofNanos(System.nanoTime() - started)).isGreaterThanOrEqualTo(Duration.ofMillis(150));
            assertThat(ran).isFalse();

            release.countDown();
            assertThat(slow.get(5, TimeUnit.SECONDS)).isTrue();
            // The rejected attempt holds no permit: the only permit is back.
            assertThat(limiter.availablePermits()).isEqualTo(1);
        } finally {
            release.countDown();
            pool.shutdownNow();
        }
    }

    @Test
    void never_more_than_N_checks_at_once_and_everyone_waiting_within_limit_gets_a_turn() throws Exception {
        int permits = 2;
        int callers = 8;
        LoginConcurrencyLimiter limiter = new LoginConcurrencyLimiter(permits, Duration.ofSeconds(10));
        AtomicInteger running = new AtomicInteger();
        AtomicInteger peak = new AtomicInteger();
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(callers);
        try {
            List<Future<Boolean>> results = new ArrayList<>();
            for (int i = 0; i < callers; i++) {
                results.add(pool.submit(() -> {
                    await(start);
                    return limiter.verify(() -> {
                        peak.accumulateAndGet(running.incrementAndGet(), Math::max);
                        sleep(50);
                        running.decrementAndGet();
                        return true;
                    });
                }));
            }
            start.countDown();
            for (Future<Boolean> result : results) {
                assertThat(result.get(10, TimeUnit.SECONDS)).isTrue();
            }
        } finally {
            pool.shutdownNow();
        }
        assertThat(peak.get()).isEqualTo(permits);
        assertThat(limiter.availablePermits()).isEqualTo(permits);
    }

    private static void await(CountDownLatch latch) {
        try {
            latch.await(10, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
