package com.blog.search.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.text.UserText;
import java.util.List;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;

/**
 * Limits and parameter validators shared by search ({@code GET /api/v1/posts/search}, {@code GET /api/v1/search}) and by
 * the public post list: one single place, so the two search paths do not drift apart.
 *
 * Error messages are fixed sentences, never echoing {@code q} or a filter value: GlobalExceptionHandler logs the message
 * of an ApiException at WARN.
 */
public final class SearchLimits {

    /** Largest page size of every public list and search. */
    public static final int MAX_PAGE_SIZE = 100;
    /**
     * Largest page whose start offset (page x size) still fits an int, the type JPA uses for that offset. A larger page is
     * clamped to this, like AdminUserService: before, page=2147483647&size=100 made Spring Data throw and return 500.
     */
    public static final int MAX_PAGE = Integer.MAX_VALUE / MAX_PAGE_SIZE;
    /** Limits of one search: code points of {@code q} after sanitizing, and the number of distinct tags. */
    public static final int MAX_QUERY_LENGTH = 200;

    public static final int MAX_TAG_FILTERS = 5;
    /** The shape of every slug SlugGenerator produces; the longest slug column is 255 (categories, series). */
    private static final Pattern SLUG = Pattern.compile("[a-z0-9]+(?:-[a-z0-9]+)*");

    private static final int MAX_SLUG_LENGTH = 255;

    private SearchLimits() {}

    public static int clampPage(int page) {
        return Math.clamp(page, 0, MAX_PAGE);
    }

    public static int clampSize(int size, int max) {
        return Math.clamp(size, 1, max);
    }

    /**
     * The sanitized {@code q} ({@link UserText#clean}); an empty string when absent.
     *
     * @throws ApiException 400 {@code VALIDATION_ERROR} when more than {@value #MAX_QUERY_LENGTH} code points remain
     */
    public static String query(String raw) {
        String text = UserText.clean(raw);
        if (text.codePointCount(0, text.length()) > MAX_QUERY_LENGTH) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.BAD_REQUEST,
                    "q must be at most " + MAX_QUERY_LENGTH + " characters");
        }
        return text;
    }

    /**
     * Tag slugs trimmed at both ends, empty elements and duplicates dropped; empty when absent.
     *
     * @throws ApiException 400 {@code VALIDATION_ERROR} when there are more than {@value #MAX_TAG_FILTERS} distinct tags
     */
    public static List<String> tagFilters(List<String> tags) {
        List<String> tagSlugs = tags == null
                ? List.of()
                : tags.stream()
                        .map(String::strip)
                        .filter(tag -> !tag.isEmpty())
                        .distinct()
                        .toList();
        if (tagSlugs.size() > MAX_TAG_FILTERS) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.BAD_REQUEST,
                    "At most " + MAX_TAG_FILTERS + " different tags can be combined");
        }
        return tagSlugs;
    }

    /** Whether a category or tag slug filters anything: absent and an empty string both mean "no filter". */
    public static boolean isFilter(String slug) {
        return slug != null && !slug.isBlank();
    }

    /**
     * A filter slug trimmed at both ends; null when absent or empty. {@code strip}, not {@code trim}: trim also removes NUL
     * and control characters, turning a broken slug into "no filter" and returning every post.
     */
    public static String slugFilter(String raw) {
        return isFilter(raw) ? raw.strip() : null;
    }

    public static boolean isSlugOrAbsent(String slug) {
        return slug == null || isSlug(slug);
    }

    public static boolean isSlug(String slug) {
        return slug.length() <= MAX_SLUG_LENGTH && SLUG.matcher(slug).matches();
    }
}
