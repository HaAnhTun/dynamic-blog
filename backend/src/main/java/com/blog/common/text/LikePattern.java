package com.blog.common.text;

import java.util.Locale;

/**
 * A "contains this string" LIKE pattern for the admin search box: comments by content, login or author name; users by
 * login or name.
 *
 * The caller compares the pattern against {@code lower(column)} and passes {@link #ESCAPE} to LIKE's ESCAPE clause. The
 * pattern is always a bind parameter, never concatenated into the SQL statement.
 */
public final class LikePattern {

    /** The escape character in the pattern: a {@code %}, {@code _} or itself after this character is a literal, not a wildcard. */
    public static final char ESCAPE = '\\';

    private LikePattern() {}

    /**
     * @param query the string the user typed. It is cleaned like comment content ({@link UserText#clean}): content is
     *              stored in that form, so pasting exactly the text you saw finds it; and NUL, which Postgres rejects in
     *              text, is dropped.
     * @return {@code %<cleaned, lowercased, escaped string>%}; null when nothing is left to search for, i.e. no filter
     */
    public static String contains(String query) {
        String cleaned = UserText.clean(query);
        if (cleaned.isEmpty()) {
            return null;
        }
        String lowered = cleaned.toLowerCase(Locale.ROOT);
        StringBuilder pattern = new StringBuilder(lowered.length() + 8).append('%');
        // Iterating by char is enough: the three characters to escape are all ASCII, never half of a surrogate pair.
        for (int i = 0; i < lowered.length(); i++) {
            char ch = lowered.charAt(i);
            if (ch == ESCAPE || ch == '%' || ch == '_') {
                pattern.append(ESCAPE);
            }
            pattern.append(ch);
        }
        return pattern.append('%').toString();
    }
}
