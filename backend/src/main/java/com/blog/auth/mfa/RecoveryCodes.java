package com.blog.auth.mfa;

import com.blog.auth.service.RefreshTokenService;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Recovery codes: the way back in when the authenticator is lost.
 *
 * Each code is 24 characters of the Crockford base32 alphabet, {@value #ALPHABET}: 24 x 5 = 120 bits, drawn one character
 * at a time with {@link SecureRandom#nextInt(int)} over a power of two (no modulo bias). They are shown as six groups of
 * four ({@code ABCD-EFGH-...}). 120 bits is not an accident: ASVS 5.0 requirement 6.5.2 lets a lookup secret with at least
 * 112 bits of entropy be stored as a plain SHA-256, which is what keeps one lookup per attempt, no salt to carry, and no
 * dependence on {@code MFA_ENCRYPTION_KEY} (rotating that key can never void a code).
 *
 * Input is normalised before it is hashed: spaces and hyphens removed, upper-cased, {@code I} and {@code L} read as
 * {@code 1} and {@code O} as {@code 0} (the Crockford rule for typing mistakes).
 */
public final class RecoveryCodes {

    public static final int COUNT = 10;
    public static final int LENGTH = 24;
    public static final String ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    /** Bits of entropy of one code; the test asserts it stays at or above the ASVS 112-bit threshold. */
    public static final int ENTROPY_BITS = LENGTH * 5;

    private static final int GROUP = 4;

    private RecoveryCodes() {}

    /** What a submitted second-step string looks like. */
    public enum Shape {
        TOTP,
        RECOVERY,
        INVALID
    }

    /** {@link #COUNT} new codes, each in its normalised 24-character form. */
    public static List<String> generate(SecureRandom random) {
        List<String> codes = new ArrayList<>(COUNT);
        while (codes.size() < COUNT) {
            StringBuilder code = new StringBuilder(LENGTH);
            for (int i = 0; i < LENGTH; i++) {
                code.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
            }
            String value = code.toString();
            if (!codes.contains(value)) {
                codes.add(value);
            }
        }
        return codes;
    }

    /** {@code ABCD-EFGH-IJKL-...}: the form shown to the person. */
    public static String format(String normalised) {
        StringBuilder grouped = new StringBuilder(normalised.length() + normalised.length() / GROUP);
        for (int i = 0; i < normalised.length(); i += GROUP) {
            if (i > 0) {
                grouped.append('-');
            }
            grouped.append(normalised, i, Math.min(i + GROUP, normalised.length()));
        }
        return grouped.toString();
    }

    /**
     * @return the 24-character normalised code, or null when the text is not one (wrong length after cleaning, or a
     *         character outside the alphabet)
     */
    public static String normalise(String input) {
        if (input == null) {
            return null;
        }
        String cleaned = input.replaceAll("[\\s\\-]", "").toUpperCase(Locale.ROOT);
        if (cleaned.length() != LENGTH) {
            return null;
        }
        StringBuilder result = new StringBuilder(LENGTH);
        for (int i = 0; i < cleaned.length(); i++) {
            char c = cleaned.charAt(i);
            char mapped = switch (c) {
                case 'I', 'L' -> '1';
                case 'O' -> '0';
                default -> c;
            };
            if (ALPHABET.indexOf(mapped) < 0) {
                return null;
            }
            result.append(mapped);
        }
        return result.toString();
    }

    /** SHA-256 hex of a normalised code: what the database stores. */
    public static String hash(String normalised) {
        return RefreshTokenService.hash(normalised);
    }

    /**
     * Decides how a submitted string is read: exactly 6 ASCII digits (after removing spaces) is an authenticator code,
     * 24 characters of the alphabet (after the normalisation above) is a recovery code, anything else is invalid.
     */
    public static Shape shapeOf(String input) {
        if (input == null) {
            return Shape.INVALID;
        }
        if (totpDigits(input) != null) {
            return Shape.TOTP;
        }
        return normalise(input) != null ? Shape.RECOVERY : Shape.INVALID;
    }

    /** The 6 digits of an authenticator code typed with or without spaces; null when the text is not one. */
    public static String totpDigits(String input) {
        if (input == null) {
            return null;
        }
        String digits = input.replaceAll("\\s", "");
        if (digits.length() != Totp.DIGITS) {
            return null;
        }
        for (int i = 0; i < digits.length(); i++) {
            char c = digits.charAt(i);
            if (c < '0' || c > '9') {
                return null;
            }
        }
        return digits;
    }
}
