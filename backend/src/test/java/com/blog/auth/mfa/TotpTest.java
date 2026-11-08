package com.blog.auth.mfa;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/** RFC 6238 known answers, the window {-1, 0}, the clock-skew diagnostic and the constant-time comparison path. */
class TotpTest {

    /** The RFC 6238 appendix B secret for HMAC-SHA1: the ASCII bytes of 12345678901234567890. */
    private static final byte[] RFC_SECRET = "12345678901234567890".getBytes(StandardCharsets.US_ASCII);

    private final Totp totp = new Totp();

    @Test
    void rfc_6238_appendix_b_vectors_for_sha1() {
        long[][] times = {
            {59L, 94287082L},
            {1111111109L, 7081804L},
            {1111111111L, 14050471L},
            {1234567890L, 89005924L},
            {2000000000L, 69279037L},
            {20000000000L, 65353130L}
        };
        for (long[] vector : times) {
            long step = Totp.stepOf(Instant.ofEpochSecond(vector[0]));
            String eightDigits = String.format("%08d", vector[1]);
            assertThat(Totp.code(RFC_SECRET, step, 8)).as("time %d", vector[0]).isEqualTo(eightDigits);
            // The product uses 6 digits: the last six of the 8-digit value (same truncation, smaller modulus).
            assertThat(Totp.code(RFC_SECRET, step)).as("time %d", vector[0]).isEqualTo(eightDigits.substring(2));
        }
    }

    @Test
    void a_step_is_thirty_seconds_of_epoch_time() {
        assertThat(Totp.stepOf(Instant.ofEpochSecond(0))).isZero();
        assertThat(Totp.stepOf(Instant.ofEpochSecond(29))).isZero();
        assertThat(Totp.stepOf(Instant.ofEpochSecond(30))).isEqualTo(1);
        assertThat(Totp.stepOf(Instant.ofEpochSecond(59))).isEqualTo(1);
    }

    @Test
    void the_current_step_and_the_one_before_are_accepted() {
        long now = 50_000_000L;

        Totp.Result current = totp.check(RFC_SECRET, Totp.code(RFC_SECRET, now), now);
        Totp.Result previous = totp.check(RFC_SECRET, Totp.code(RFC_SECRET, now - 1), now);

        assertThat(current.matchedStep()).hasValue(now);
        assertThat(current.skewSteps()).isEmpty();
        assertThat(previous.matchedStep()).hasValue(now - 1);
    }

    @Test
    void the_next_step_and_everything_older_than_one_step_are_refused() {
        long now = 50_000_000L;
        Set<String> codes = new LinkedHashSet<>();
        for (int offset = -11; offset <= 11; offset++) {
            codes.add(Totp.code(RFC_SECRET, now + offset));
        }
        // The known-answer check below is only meaningful when no two steps of this window share a code.
        assertThat(codes).hasSize(23);

        for (int offset : new int[] {1, -2, -3, 5, -10, 10}) {
            Totp.Result result = totp.check(RFC_SECRET, Totp.code(RFC_SECRET, now + offset), now);
            assertThat(result.matchedStep()).as("offset %d", offset).isEmpty();
        }
    }

    @Test
    void the_diagnostic_reports_the_offset_of_a_code_two_to_ten_steps_away_and_still_refuses_it() {
        long now = 50_000_000L;
        for (int offset : new int[] {-10, -5, -2, 1, 2, 7, 10}) {
            Totp.Result result = totp.check(RFC_SECRET, Totp.code(RFC_SECRET, now + offset), now);
            assertThat(result.matchedStep()).as("offset %d", offset).isEmpty();
            assertThat(result.skewSteps()).as("offset %d", offset).hasValue(offset);
        }
        for (int offset : new int[] {-11, -30, 11, 40}) {
            Totp.Result result = totp.check(RFC_SECRET, Totp.code(RFC_SECRET, now + offset), now);
            assertThat(result.matchedStep()).isEmpty();
            assertThat(result.skewSteps()).as("offset %d", offset).isEmpty();
        }
    }

    @Test
    void a_code_of_the_wrong_length_or_with_other_characters_never_matches() {
        long now = 50_000_000L;
        String valid = Totp.code(RFC_SECRET, now);
        for (String bad : new String[] {"", "12345", valid + "0", valid.substring(1), "abcdef", "12 456", "12345a"}) {
            Totp.Result result = totp.check(RFC_SECRET, bad, now);
            assertThat(result.matchedStep()).as("input '%s'", bad).isEmpty();
        }
    }

    @Test
    void both_candidates_are_always_compared_so_the_time_does_not_reveal_which_step_matched() {
        AtomicInteger comparisons = new AtomicInteger();
        Totp counting = new Totp((expected, given) -> {
            comparisons.incrementAndGet();
            return MessageDigest.isEqual(expected, given);
        });
        long now = 50_000_000L;

        counting.check(RFC_SECRET, Totp.code(RFC_SECRET, now), now);
        assertThat(comparisons.getAndSet(0)).isEqualTo(2);
        counting.check(RFC_SECRET, Totp.code(RFC_SECRET, now - 1), now);
        assertThat(comparisons.getAndSet(0)).isEqualTo(2);
        // No match: the two candidates, then the nineteen diagnostic steps (-10..-2 and +1..+10), none skipped once
        // something is found.
        counting.check(RFC_SECRET, Totp.code(RFC_SECRET, now + 3), now);
        assertThat(comparisons.getAndSet(0)).isEqualTo(21);
    }

    @Test
    void the_code_is_six_digits_with_leading_zeros() {
        for (long step = 0; step < 300; step++) {
            assertThat(Totp.code(RFC_SECRET, step)).matches("[0-9]{6}");
        }
    }
}
