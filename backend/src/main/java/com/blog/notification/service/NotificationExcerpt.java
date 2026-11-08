package com.blog.notification.service;

import java.util.regex.Pattern;

/**
 * The excerpt of a comment inside a notification: a single line of plain text, not HTML, and the frontend renders
 * it as a text node. Only ever called with the content of a VISIBLE comment, which is already public.
 */
final class NotificationExcerpt {

    /** The longest length, in code points (as CommentContent counts), before the "…". */
    static final int MAX_CODE_POINTS = 120;

    /**
     * Any run of whitespace: newlines, tabs, and also Unicode spaces such as the non-breaking space (U+00A0) or the
     * CJK ideographic space, which Java's default {@code \s} does not match.
     */
    private static final Pattern WHITESPACE = Pattern.compile("[\\s\\p{Z}]+");

    private NotificationExcerpt() {}

    /**
     * Collapses each run of whitespace into one space and trims both ends. If longer than {@value #MAX_CODE_POINTS}
     * code points, cuts at exactly code point {@value #MAX_CODE_POINTS} (never splitting a surrogate pair), drops
     * any space the cut leaves at the end, then appends "…"; if not longer, returns it unchanged, without "…".
     */
    static String of(String content) {
        String text = WHITESPACE.matcher(content).replaceAll(" ").strip();
        if (text.codePointCount(0, text.length()) <= MAX_CODE_POINTS) {
            return text;
        }
        return text.substring(0, text.offsetByCodePoints(0, MAX_CODE_POINTS)).stripTrailing() + "…";
    }
}
