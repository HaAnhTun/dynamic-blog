package com.blog.common.util;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.security.SecureRandom;
import java.text.Normalizer;
import java.util.HexFormat;
import java.util.Locale;
import java.util.function.Predicate;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;

public final class SlugGenerator {

    private static final Pattern DIACRITICS = Pattern.compile("\\p{M}");
    private static final Pattern NON_ALPHANUMERIC = Pattern.compile("[^a-z0-9]+");
    private static final Pattern EDGE_HYPHENS = Pattern.compile("^-+|-+$");

    private SlugGenerator() {}

    /**
     * Normalisation only, with no fallback: an empty result means nothing in the input
     * survived. Callers with a second source for the slug — the post title, say — use
     * this and choose their own fallback; callers with nothing else use slugify.
     */
    public static String slugifyOrEmpty(String input) {
        String normalized = Normalizer.normalize(input, Normalizer.Form.NFD);
        String withoutDiacritics = DIACRITICS.matcher(normalized).replaceAll("");
        // d-stroke letters (U+0111, U+0110) do not decompose under NFD, so map them explicitly.
        withoutDiacritics = withoutDiacritics.replace('\u0111', 'd').replace('\u0110', 'D');
        String lower = withoutDiacritics.toLowerCase(Locale.ROOT);
        String hyphenated = NON_ALPHANUMERIC.matcher(lower).replaceAll("-");
        return EDGE_HYPHENS.matcher(hyphenated).replaceAll("");
    }

    public static String slugify(String input) {
        String slug = slugifyOrEmpty(input);
        // "untitled" rather than "" because a post with an empty slug would live at
        // /posts/, which routes to the post list — the post would be unreachable.
        return slug.isEmpty() ? "untitled" : slug;
    }

    /** How many numbered candidates ({@code base-2} ... {@code base-51}) are tried before a random suffix is used. */
    public static final int MAX_SEQUENTIAL_PROBES = 50;

    /** How many random suffixes are tried before giving up. */
    private static final int RANDOM_PROBES = 3;

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final HexFormat HEX = HexFormat.of();

    /**
     * The base slug when it is free, else the first free {@code base-2}, {@code base-3} ... Bounded: the predicate is a
     * database query, and someone who has squatted {@code base-2} to {@code base-1000} must not turn one request into a
     * thousand queries. After {@value #MAX_SEQUENTIAL_PROBES} numbered candidates it tries a few {@code base-<8 hex digits>}
     * (random, so not guessable), and then gives up.
     *
     * @throws ApiException 409 {@code RESOURCE_CONFLICT} when no free slug was found (practically unreachable)
     */
    public static String ensureUnique(String baseSlug, Predicate<String> existsBySlug) {
        if (!existsBySlug.test(baseSlug)) {
            return baseSlug;
        }
        for (int suffix = 2; suffix < 2 + MAX_SEQUENTIAL_PROBES; suffix++) {
            String candidate = baseSlug + "-" + suffix;
            if (!existsBySlug.test(candidate)) {
                return candidate;
            }
        }
        for (int attempt = 0; attempt < RANDOM_PROBES; attempt++) {
            byte[] bytes = new byte[4];
            RANDOM.nextBytes(bytes);
            String candidate = baseSlug + "-" + HEX.formatHex(bytes);
            if (!existsBySlug.test(candidate)) {
                return candidate;
            }
        }
        throw new ApiException(
                ErrorCode.RESOURCE_CONFLICT, HttpStatus.CONFLICT, "Could not find a free slug; choose another one");
    }
}
