package com.blog.common.security;

import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;

/**
 * Tells an obviously weak secret from a random one, for the secrets an operator may fill in by hand (JWT_SECRET,
 * VIEWS_TOKEN, CLIENT_IP_TOKEN, NEWSLETTER_SECRET). It is a floor, not an entropy meter: it refuses the values that a
 * person types when no tool made them, and it accepts every value that the documented commands produce
 * ({@code openssl rand -base64 48}, {@code openssl rand -hex 32}, what {@code scripts/init-env} writes). A test generates
 * thousands of both shapes to keep it so.
 *
 * What it refuses:
 * <ul>
 *   <li>a value made only of well-known placeholder words ("changeme", "secret", "password" ...), in any case and with any
 *       separators;</li>
 *   <li>a value that repeats one short pattern from start to end ("aaaa...", "abcabc...", a 16-character value pasted
 *       twice to reach 32);</li>
 *   <li>fewer than {@value #MIN_DISTINCT_CHARACTERS} different characters;</li>
 *   <li>a value that is mostly one run of characters in sequence, at least {@value #MIN_SEQUENCE} of them and half of the
 *       value ("abcdefghij...", "0123456789...", and the same backwards); a phrase that merely ends in 0123456789
 *       passes.</li>
 * </ul>
 *
 * Only the reason is returned, never the value: the caller puts it into a startup error, and a startup error is where a
 * secret would survive log rotation.
 */
public final class SecretStrength {

    /** Fewer different characters than this is not random: a hex value of 16 characters or more has at least this many. */
    static final int MIN_DISTINCT_CHARACTERS = 6;

    /** A run of at least this many characters (code points one apart) can make a value a sequence. */
    static final int MIN_SEQUENCE = 10;

    /** Words people put in a secret field when nothing generated one; compared after lower-casing and dropping separators. */
    private static final List<String> PLACEHOLDER_WORDS = List.of(
            "changeme",
            "changeit",
            "openssl",
            "rand",
            "base64",
            "hex",
            "32",
            "48",
            "64",
            "replaceme",
            "secret",
            "password",
            "passw0rd",
            "default",
            "example",
            "sample",
            "placeholder",
            "token",
            "key",
            "jwt",
            "views",
            "admin",
            "blog",
            "test",
            "testing",
            "dev",
            "development",
            "production",
            "random",
            "generated",
            "insecure",
            "unsafe",
            "letmein",
            "qwerty",
            "welcome",
            "my",
            "your",
            "this",
            "is",
            "todo",
            "fixme",
            "xxx",
            "none",
            "null",
            "empty",
            "true",
            "false");

    private SecretStrength() {}

    /**
     * @return why the value is too weak to protect anything, as a phrase that fits after the name of the variable ("is
     *         ..."), or empty when it passes. Never contains the value.
     */
    public static Optional<String> weakness(String secret) {
        if (secret == null || secret.isBlank()) {
            return Optional.of("is empty");
        }
        String value = secret.strip();
        if (madeOnlyOfPlaceholderWords(value)) {
            return Optional.of("is made only of well-known placeholder words");
        }
        if (repeatsAShortPattern(value)) {
            return Optional.of("repeats one short pattern from start to end");
        }
        if (distinctCharacters(value) < MIN_DISTINCT_CHARACTERS) {
            return Optional.of("uses fewer than " + MIN_DISTINCT_CHARACTERS + " different characters");
        }
        int run = longestSequence(value);
        if (run >= MIN_SEQUENCE && run * 2 >= value.length()) {
            return Optional.of("is mostly a run of characters in sequence (abcdefghij, 0123456789)");
        }
        return Optional.empty();
    }

    /**
     * The check that fails a production start: too short, or weak by {@link #weakness}. The message names the variable,
     * the reason and the command that makes a good value; it never holds the value.
     *
     * @param variable   the environment variable, for the message
     * @param minLength  the fewest characters accepted (0 when another check already owns the length)
     * @param generateWith a command that makes a good value, for the message
     * @throws IllegalStateException when the value is weak
     */
    public static void require(String variable, String secret, int minLength, String generateWith) {
        String reason = weakness(secret).orElse(null);
        if (reason == null && secret.strip().length() < minLength) {
            reason = "is shorter than " + minLength + " characters";
        }
        if (reason != null) {
            throw new IllegalStateException(variable + " " + reason + ", which is too weak for a production run. "
                    + "Generate a random value with: " + generateWith);
        }
    }

    /** Lower case letters and digits only, so "Change-Me_please" and "changemeplease" compare alike. */
    private static String normalised(String value) {
        StringBuilder out = new StringBuilder(value.length());
        for (char c : value.toLowerCase(Locale.ROOT).toCharArray()) {
            if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
                out.append(c);
            }
        }
        return out.toString();
    }

    /** Whether the whole normalised value can be cut into placeholder words. */
    private static boolean madeOnlyOfPlaceholderWords(String value) {
        String text = normalised(value);
        if (text.isEmpty()) {
            return false;
        }
        boolean[] reachable = new boolean[text.length() + 1];
        reachable[0] = true;
        for (int end = 1; end <= text.length(); end++) {
            for (String word : PLACEHOLDER_WORDS) {
                int start = end - word.length();
                if (start >= 0 && reachable[start] && text.startsWith(word, start)) {
                    reachable[end] = true;
                    break;
                }
            }
        }
        return reachable[text.length()];
    }

    /** Whether the value is its first {@code period} characters repeated at least twice (the last copy may be cut short). */
    private static boolean repeatsAShortPattern(String value) {
        for (int period = 1; period <= value.length() / 2; period++) {
            boolean repeats = true;
            for (int i = period; i < value.length() && repeats; i++) {
                repeats = value.charAt(i) == value.charAt(i - period);
            }
            if (repeats) {
                return true;
            }
        }
        return false;
    }

    private static int distinctCharacters(String value) {
        Set<Integer> seen = new HashSet<>();
        value.codePoints().forEach(seen::add);
        return seen.size();
    }

    /** The length of the longest stretch whose code points rise by one each step, or fall by one each step. */
    private static int longestSequence(String value) {
        int[] points = value.codePoints().toArray();
        int longest = 1;
        int up = 1;
        int down = 1;
        for (int i = 1; i < points.length; i++) {
            up = points[i] == points[i - 1] + 1 ? up + 1 : 1;
            down = points[i] == points[i - 1] - 1 ? down + 1 : 1;
            longest = Math.max(longest, Math.max(up, down));
        }
        return longest;
    }
}
