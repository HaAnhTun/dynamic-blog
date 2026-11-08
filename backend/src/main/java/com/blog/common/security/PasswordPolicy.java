package com.blog.common.security;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * The one password policy of the site, for every place that accepts a new account password: the first-run setup, the
 * {@code ADMIN_PASSWORD} startup runner and the password change. Existing hashes are never re-checked at login.
 *
 * A password is refused when it:
 * <ul>
 *   <li>is shorter than {@value #MIN_LENGTH} or longer than {@value #MAX_LENGTH} characters (counted as
 *       {@code String.length()}, like {@code @Size}); no Unicode normalisation, consistent with the hash input;</li>
 *   <li>is on the bundled list of the 10,000 most common passwords, compared case-insensitively and ignoring
 *       surrounding whitespace, or is such a word with only digits and symbols around it
 *       ({@code Welcome12345!}, {@code 2024password}): the length floor alone lets those through;</li>
 *   <li>is built from fewer than {@value #MIN_DISTINCT_CHARACTERS} different characters or is one run of consecutive
 *       characters ({@code aaaaaaaaaaaa}, {@code 123456789012});</li>
 *   <li>contains the local part of the account's email address (at least {@value #MIN_LOCAL_PART} characters, so a
 *       short local part does not refuse half of all passwords) or the development password of the seeded admin;</li>
 *   <li>is equal to the current password (the password change only).</li>
 * </ul>
 * Every violation of the weak family answers with the very same message, so the answer is not an oracle for the bundled
 * list. No message contains the password, the email or a list entry.
 *
 * The list is the "10k-most-common" file of the SecLists project (MIT), lower-cased and without duplicates; docs/ASSETS.md
 * records its origin.
 */
@Component
public class PasswordPolicy {

    public static final int MIN_LENGTH = 12;
    public static final int MAX_LENGTH = 128;
    static final int MIN_DISTINCT_CHARACTERS = 5;
    static final int MIN_LOCAL_PART = 4;

    private static final String LIST_RESOURCE = "security/common-passwords.txt";

    /** Why a password was refused. The public message of each is stable and never carries a value. */
    public enum Violation {
        TOO_SHORT("must be at least " + MIN_LENGTH + " characters long"),
        TOO_LONG("must be at most " + MAX_LENGTH + " characters long"),
        /** On the common list, built around a listed word, repetitive, containing the email local part, or the dev password. */
        TOO_COMMON("is too common or too easy to guess"),
        SAME_AS_CURRENT("must be different from the current password");

        private final String message;

        Violation(String message) {
            this.message = message;
        }

        /** The sentence after the field name: {@code newPassword: <message>}. */
        public String message() {
            return message;
        }
    }

    private final Set<String> common;

    public PasswordPolicy() {
        this.common = loadBundledList();
    }

    /** For a test that needs a small list of its own. */
    PasswordPolicy(Set<String> commonLowerCase) {
        this.common = Set.copyOf(commonLowerCase);
    }

    /**
     * @param password the candidate; null is too short
     * @param email    the account's email, or null when the account has none or it is not known yet
     * @param current  the current password for a change, else null
     * @return the first violation, empty when the password is acceptable
     */
    public Optional<Violation> check(String password, String email, String current) {
        if (password == null || password.length() < MIN_LENGTH) {
            return Optional.of(Violation.TOO_SHORT);
        }
        if (password.length() > MAX_LENGTH) {
            return Optional.of(Violation.TOO_LONG);
        }
        if (current != null && current.equals(password)) {
            return Optional.of(Violation.SAME_AS_CURRENT);
        }
        if (isWeak(password, email)) {
            return Optional.of(Violation.TOO_COMMON);
        }
        return Optional.empty();
    }

    public Optional<Violation> check(String password, String email) {
        return check(password, email, null);
    }

    /**
     * @param field the name the message starts with, for example {@code password} or {@code newPassword}
     * @throws ApiException 400 {@code VALIDATION_ERROR} with {@code <field>: <stable message>}
     */
    public void require(String field, String password, String email, String current) {
        check(password, email, current).ifPresent(violation -> {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, field + ": " + violation.message());
        });
    }

    private boolean isWeak(String password, String email) {
        String lower = password.strip().toLowerCase(Locale.ROOT);
        if (common.contains(lower) || common.contains(letterCore(lower))) {
            return true;
        }
        if (lower.contains(SeedAdmin.DEV_PASSWORD)) {
            return true;
        }
        if (distinctCharacters(lower) < MIN_DISTINCT_CHARACTERS || isConsecutiveRun(lower)) {
            return true;
        }
        String localPart = localPart(email);
        return localPart != null && lower.contains(localPart);
    }

    /** The password without the digits and symbols at both ends: {@code 2024password!!} gives {@code password}. */
    private static String letterCore(String lower) {
        int start = 0;
        int end = lower.length();
        while (start < end && !Character.isLetter(lower.charAt(start))) {
            start++;
        }
        while (end > start && !Character.isLetter(lower.charAt(end - 1))) {
            end--;
        }
        return lower.substring(start, end);
    }

    private static int distinctCharacters(String value) {
        Set<Integer> distinct = new HashSet<>();
        value.codePoints().forEach(distinct::add);
        return distinct.size();
    }

    /**
     * Every character one code point after the previous one, or every one before it ({@code abcdefghijkl}); digits wrap
     * around, so {@code 123456789012} and {@code 987654321098} are runs too.
     */
    private static boolean isConsecutiveRun(String value) {
        int[] points = value.codePoints().toArray();
        if (points.length < 2) {
            return false;
        }
        boolean digits = value.chars().allMatch(c -> c >= '0' && c <= '9');
        int step = delta(points[1], points[0], digits);
        if (step != 1 && step != -1) {
            return false;
        }
        for (int i = 1; i < points.length; i++) {
            if (delta(points[i], points[i - 1], digits) != step) {
                return false;
            }
        }
        return true;
    }

    private static int delta(int current, int previous, boolean digits) {
        int difference = current - previous;
        if (digits && difference == -9) {
            return 1;
        }
        if (digits && difference == 9) {
            return -1;
        }
        return difference;
    }

    /** The lower-cased part of the address before the {@code @}, or null when too short to be a useful needle. */
    private static String localPart(String email) {
        if (email == null) {
            return null;
        }
        int at = email.indexOf('@');
        String local = (at < 0 ? email : email.substring(0, at)).strip().toLowerCase(Locale.ROOT);
        return local.length() >= MIN_LOCAL_PART ? local : null;
    }

    private static Set<String> loadBundledList() {
        Set<String> words = new HashSet<>();
        try (InputStream in = new ClassPathResource(LIST_RESOURCE).getInputStream();
                BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                String word = line.strip().toLowerCase(Locale.ROOT);
                if (!word.isEmpty()) {
                    words.add(word);
                }
            }
        } catch (IOException e) {
            throw new UncheckedIOException("The bundled list of common passwords could not be read", e);
        }
        if (words.size() < 1_000) {
            throw new IllegalStateException("The bundled list of common passwords is incomplete");
        }
        return Set.copyOf(words);
    }
}
