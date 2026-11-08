package com.blog.auth.mfa;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.InvalidKeyException;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.Locale;
import java.util.OptionalInt;
import java.util.OptionalLong;
import java.util.function.BiPredicate;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Time-based one-time passwords (RFC 6238) over HMAC-SHA1 with {@code javax.crypto}: 6 digits, 30-second steps, a 160-bit
 * secret, fixed because those are the only parameters every authenticator app supports (other values silently break
 * Google Authenticator). The truncation is RFC 4226, section 5.3.
 *
 * <h2>Window</h2>
 * A code is valid for the current step and the one before it, {@code {-1, 0}}: a code typed across a step boundary still
 * works, and it lives at most 60 seconds (ASVS 6.5.5 asks for 30; the deviation is recorded in docs/SECURITY.md). Both
 * candidates are always computed and compared in constant time, with no early exit, so the time taken does not reveal
 * which step matched.
 *
 * <h2>Clock skew diagnostic</h2>
 * Only when neither candidate matched, the codes of the steps {@code -10..-2} and {@code +1..+10} are computed too. A
 * match there is reported in {@link Result#skewSteps()} and is <em>still refused</em>: it tells the operator that a
 * clock is wrong, it accepts nothing.
 *
 * The class never logs and never keeps a secret.
 */
public final class Totp {

    public static final int PERIOD_SECONDS = 30;
    public static final int DIGITS = 6;

    private static final int DIAGNOSTIC_STEPS = 10;
    private static final int[] POWERS_OF_TEN = {1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000};

    private final BiPredicate<byte[], byte[]> constantTimeEquals;

    public Totp() {
        this(MessageDigest::isEqual);
    }

    /** For a test that counts the comparisons: the seam that proves both candidates are always compared. */
    Totp(BiPredicate<byte[], byte[]> constantTimeEquals) {
        this.constantTimeEquals = constantTimeEquals;
    }

    /**
     * @param matchedStep the greatest step of the window whose code equals the submitted one; empty when none does
     * @param skewSteps   when nothing matched: the offset in steps (relative to the current one) of the diagnostic step
     *                    whose code equals the submitted one; empty when none does. Never set together with a match
     */
    public record Result(OptionalLong matchedStep, OptionalInt skewSteps) {}

    /** The step number of an instant: seconds since the epoch divided by the 30-second period. */
    public static long stepOf(Instant at) {
        return Math.floorDiv(at.getEpochSecond(), (long) PERIOD_SECONDS);
    }

    /** The 6-digit code of one step. */
    public static String code(byte[] secret, long step) {
        return code(secret, step, DIGITS);
    }

    /** Any length up to 8 digits; the RFC 6238 appendix B vectors are 8 digits long. */
    static String code(byte[] secret, long step, int digits) {
        byte[] hash =
                hmacSha1(secret, ByteBuffer.allocate(Long.BYTES).putLong(step).array());
        int offset = hash[hash.length - 1] & 0x0f;
        int binary = ((hash[offset] & 0x7f) << 24)
                | ((hash[offset + 1] & 0xff) << 16)
                | ((hash[offset + 2] & 0xff) << 8)
                | (hash[offset + 3] & 0xff);
        int value = binary % POWERS_OF_TEN[digits];
        return String.format(Locale.ROOT, "%0" + digits + "d", value);
    }

    /**
     * Checks a submitted code against the window of the current step.
     *
     * @param submitted exactly {@value #DIGITS} ASCII digits; anything else cannot match (and is still compared against
     *                  both candidates, so its shape does not change the work)
     */
    public Result check(byte[] secret, String submitted, long currentStep) {
        byte[] given = submitted.getBytes(StandardCharsets.US_ASCII);
        boolean current = matches(secret, currentStep, given);
        boolean previous = matches(secret, currentStep - 1, given);
        if (current) {
            return new Result(OptionalLong.of(currentStep), OptionalInt.empty());
        }
        if (previous) {
            return new Result(OptionalLong.of(currentStep - 1), OptionalInt.empty());
        }
        return new Result(OptionalLong.empty(), skew(secret, currentStep, given));
    }

    private OptionalInt skew(byte[] secret, long currentStep, byte[] given) {
        OptionalInt found = OptionalInt.empty();
        for (int offset = -DIAGNOSTIC_STEPS; offset <= DIAGNOSTIC_STEPS; offset++) {
            if (offset == 0 || offset == -1) {
                continue;
            }
            if (matches(secret, currentStep + offset, given) && found.isEmpty()) {
                found = OptionalInt.of(offset);
            }
        }
        return found;
    }

    private boolean matches(byte[] secret, long step, byte[] given) {
        return constantTimeEquals.test(code(secret, step).getBytes(StandardCharsets.US_ASCII), given);
    }

    private static byte[] hmacSha1(byte[] key, byte[] message) {
        try {
            Mac mac = Mac.getInstance("HmacSHA1");
            mac.init(new SecretKeySpec(key, "HmacSHA1"));
            return mac.doFinal(message);
        } catch (InvalidKeyException e) {
            throw new IllegalStateException("The TOTP secret is not a usable HMAC key", e);
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA1 is required by every JVM", e);
        }
    }
}
