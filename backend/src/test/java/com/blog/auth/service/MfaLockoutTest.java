package com.blog.auth.service;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.auth.service.MfaLockout.Failure;
import com.blog.auth.service.MfaLockout.State;
import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.Test;

/** The brake on wrong second-step codes: pure arithmetic over the stored counters, a fixed instant, no Spring. */
class MfaLockoutTest {

    private static final Instant NOW = Instant.parse("2026-10-18T10:00:00Z");

    @Test
    void the_first_four_wrong_codes_cost_nothing_and_the_fifth_starts_the_delays() {
        int failed = 0;
        for (int expectedFailed = 1; expectedFailed <= 4; expectedFailed++) {
            Failure failure = MfaLockout.afterFailure(failed, NOW);
            assertThat(failure.failedAttempts()).isEqualTo(expectedFailed);
            assertThat(failure.lockedUntil()).as("failure %d", expectedFailed).isNull();
            failed = failure.failedAttempts();
        }
        assertThat(MfaLockout.afterFailure(4, NOW).lockedUntil()).isEqualTo(NOW.plusSeconds(30));
    }

    @Test
    void the_delay_doubles_from_the_fifth_failure_and_is_capped_at_fifteen_minutes() {
        assertThat(MfaLockout.delayAfter(5)).isEqualTo(Duration.ofSeconds(30));
        assertThat(MfaLockout.delayAfter(6)).isEqualTo(Duration.ofSeconds(60));
        assertThat(MfaLockout.delayAfter(7)).isEqualTo(Duration.ofSeconds(120));
        assertThat(MfaLockout.delayAfter(8)).isEqualTo(Duration.ofSeconds(240));
        assertThat(MfaLockout.delayAfter(9)).isEqualTo(Duration.ofSeconds(480));
        assertThat(MfaLockout.delayAfter(10)).isEqualTo(Duration.ofMinutes(15));
        assertThat(MfaLockout.delayAfter(11)).isEqualTo(Duration.ofMinutes(15));
        assertThat(MfaLockout.delayAfter(99)).isEqualTo(Duration.ofMinutes(15));
        assertThat(MfaLockout.delayAfter(0)).isZero();
        assertThat(MfaLockout.delayAfter(4)).isZero();
    }

    @Test
    void a_lock_in_the_future_refuses_even_a_correct_code_and_an_ended_lock_does_not() {
        Instant lockedUntil = NOW.plusSeconds(30);

        assertThat(MfaLockout.stateOf(5, lockedUntil, NOW)).isEqualTo(State.LOCKED);
        assertThat(MfaLockout.stateOf(5, lockedUntil, NOW.plusSeconds(29))).isEqualTo(State.LOCKED);
        // The delay is over: the next code is evaluated, and a correct one resets the counters (MfaRepository).
        assertThat(MfaLockout.stateOf(5, lockedUntil, NOW.plusSeconds(30))).isEqualTo(State.OPEN);
        assertThat(MfaLockout.stateOf(5, lockedUntil, NOW.plusSeconds(31))).isEqualTo(State.OPEN);
        assertThat(MfaLockout.stateOf(0, null, NOW)).isEqualTo(State.OPEN);
        assertThat(MfaLockout.stateOf(4, null, NOW)).isEqualTo(State.OPEN);
    }

    @Test
    void the_hundredth_consecutive_failure_freezes_the_second_step_and_is_reported_exactly_once() {
        int failed = 0;
        int reports = 0;
        for (int i = 1; i <= 120; i++) {
            Failure failure = MfaLockout.afterFailure(failed, NOW);
            if (failure.frozenNow()) {
                reports++;
                assertThat(failure.failedAttempts()).isEqualTo(MfaLockout.CEILING);
            }
            failed = failure.failedAttempts();
        }
        assertThat(reports)
                .as("the ERROR line is written once, at the 100th failure")
                .isEqualTo(1);
    }

    @Test
    void a_frozen_second_step_stays_frozen_whatever_the_clock_says() {
        assertThat(MfaLockout.stateOf(99, null, NOW)).isEqualTo(State.OPEN);
        assertThat(MfaLockout.stateOf(100, null, NOW)).isEqualTo(State.FROZEN);
        assertThat(MfaLockout.stateOf(100, NOW.minusSeconds(86_400), NOW)).isEqualTo(State.FROZEN);
        assertThat(MfaLockout.stateOf(250, NOW.minusSeconds(86_400), NOW.plusSeconds(86_400 * 30L)))
                .isEqualTo(State.FROZEN);
    }

    @Test
    void the_arithmetic_of_the_ceiling_is_what_the_documentation_claims() {
        // Five free guesses, then the delays of 30, 60, 120, 240 and 480 seconds, then 15 minutes up to the ceiling.
        long seconds = 0;
        for (int failures = 5; failures < MfaLockout.CEILING; failures++) {
            seconds += MfaLockout.delayAfter(failures).toSeconds();
        }
        // 930 s of escalating delays, then 90 guesses at 15 minutes each (the 100th failure has no delay to wait for).
        assertThat(seconds).isEqualTo(930 + 90 * 900);
        // About 23 hours from the first wrong code to the freeze.
        assertThat(Duration.ofSeconds(seconds).toHours()).isBetween(22L, 24L);
    }

    @Test
    void the_wait_a_client_is_told_is_whole_seconds_and_at_least_one() {
        assertThat(MfaLockout.secondsLeft(NOW.plusSeconds(30), NOW)).isEqualTo(30);
        assertThat(MfaLockout.secondsLeft(NOW.plusMillis(1_001), NOW)).isEqualTo(2);
        assertThat(MfaLockout.secondsLeft(NOW.plusMillis(1), NOW)).isEqualTo(1);
        assertThat(MfaLockout.secondsLeft(NOW.minusSeconds(5), NOW)).isEqualTo(1);
    }
}
