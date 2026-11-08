package com.blog.common.util;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

/** The once-per-window gate for log lines that a caller can repeat at will (issue 089). */
class LogThrottleTest {

    private final AtomicLong now = new AtomicLong();
    private final LogThrottle throttle = new LogThrottle(Duration.ofMinutes(1), 4, now::get);

    @Test
    void the_first_event_of_a_key_is_logged_and_the_repeats_inside_the_window_are_not() {
        assertThat(throttle.record("a")).isZero();
        for (int i = 0; i < 100; i++) {
            assertThat(throttle.record("a")).isEqualTo(LogThrottle.REPEAT);
        }
    }

    @Test
    void the_next_window_logs_again_and_says_how_many_were_left_out() {
        throttle.record("a");
        for (int i = 0; i < 7; i++) {
            throttle.record("a");
        }
        now.addAndGet(Duration.ofSeconds(59).toNanos());
        assertThat(throttle.record("a")).isEqualTo(LogThrottle.REPEAT);

        now.addAndGet(Duration.ofSeconds(2).toNanos());
        assertThat(throttle.record("a")).isEqualTo(8);
        assertThat(throttle.record("a")).isEqualTo(LogThrottle.REPEAT);
    }

    @Test
    void keys_do_not_share_a_window() {
        assertThat(throttle.record("a")).isZero();
        assertThat(throttle.record("b")).isZero();
        assertThat(throttle.record("a")).isEqualTo(LogThrottle.REPEAT);
        assertThat(throttle.record("b")).isEqualTo(LogThrottle.REPEAT);
    }

    @Test
    void the_memory_is_bounded_and_a_key_that_does_not_fit_is_logged_rather_than_hidden() {
        for (String key : new String[] {"a", "b", "c", "d"}) {
            assertThat(throttle.record(key)).isZero();
        }
        assertThat(throttle.trackedKeys()).isEqualTo(4);

        // A fifth key is not stored, so every event of it is logged (the safe side for a security line).
        assertThat(throttle.record("e")).isZero();
        assertThat(throttle.record("e")).isZero();
        assertThat(throttle.trackedKeys()).isEqualTo(4);
    }

    @Test
    void an_idle_key_is_dropped_so_that_a_new_one_fits_again() {
        for (String key : new String[] {"a", "b", "c", "d"}) {
            throttle.record(key);
        }
        now.addAndGet(Duration.ofMinutes(5).toNanos());

        assertThat(throttle.record("e")).isZero();
        assertThat(throttle.record("e")).isEqualTo(LogThrottle.REPEAT);
        assertThat(throttle.trackedKeys()).isLessThanOrEqualTo(4);
    }
}
