package com.blog.auth.oauth;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.junit.jupiter.api.Test;

/**
 * Registry of consumed states: blocks replaying the callback a second time within 10 minutes, and is never a valve for
 * blocking other people from logging in (when full the oldest entry is dropped, a new state is never rejected).
 */
class ConsumedStateRegistryTest {

    private final MutableClock clock = new MutableClock();

    @Test
    void state_can_be_used_only_once() {
        ConsumedStateRegistry registry = new ConsumedStateRegistry(clock, 100);

        assertThat(registry.consume("state-a")).isTrue();
        assertThat(registry.consume("state-a")).isFalse();
        assertThat(registry.consume("state-b")).isTrue();
    }

    @Test
    void entries_older_than_10_minutes_are_cleaned_from_registry_head_on_next_write() {
        ConsumedStateRegistry registry = new ConsumedStateRegistry(clock, 100);
        registry.consume("state-a");
        clock.advance(Duration.ofMinutes(1));
        registry.consume("state-b");

        // Right at the boundary: state-a has exactly 1 ms left before expiry, so it is still treated as consumed.
        clock.advance(Duration.ofMinutes(9).minusMillis(1));
        assertThat(registry.consume("state-a")).isFalse();
        assertThat(registry.size()).isEqualTo(2);

        // Past state-a's 10 minutes: the next write cleans it up; state-b (written 1 minute later) is still there.
        clock.advance(Duration.ofMillis(1));
        assertThat(registry.consume("state-c")).isTrue();
        assertThat(registry.size()).isEqualTo(2);
        assertThat(registry.consume("state-b")).isFalse();

        clock.advance(Duration.ofMinutes(10));
        assertThat(registry.consume("state-d")).isTrue();
        assertThat(registry.size()).isEqualTo(1);
    }

    @Test
    void full_registry_drops_oldest_entry_and_still_accepts_every_new_state() {
        ConsumedStateRegistry registry = new ConsumedStateRegistry(clock, 3);

        for (String state : List.of("state-1", "state-2", "state-3", "state-4", "state-5")) {
            assertThat(registry.consume(state)).as(state).isTrue();
        }

        assertThat(registry.size()).isEqualTo(3);
        // The newest entry is still blocked...
        assertThat(registry.consume("state-5")).isFalse();
        assertThat(registry.consume("state-3")).isFalse();
        // ...the oldest entry was dropped: GitHub's single-use code is the last net, a full registry must not block
        // anyone's login.
        assertThat(registry.consume("state-1")).isTrue();
        assertThat(registry.size()).isEqualTo(3);
    }

    @Test
    void many_threads_using_same_state_exactly_one_wins() throws Exception {
        ConsumedStateRegistry registry = new ConsumedStateRegistry(clock, 100);
        int threads = 8;
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            List<Future<Boolean>> results = new ArrayList<>();
            for (int i = 0; i < threads; i++) {
                Callable<Boolean> consume = () -> {
                    start.await();
                    return registry.consume("cung-mot-state");
                };
                results.add(pool.submit(consume));
            }
            start.countDown();

            int accepted = 0;
            for (Future<Boolean> result : results) {
                accepted += result.get() ? 1 : 0;
            }
            assertThat(accepted).isEqualTo(1);
        } finally {
            pool.shutdownNow();
        }
    }
}
