package com.blog.analytics.service;

import java.util.Locale;

/**
 * Source group of a view. A fixed list, matching the CHECK on {@code post_view_daily.source} (V30); the declaration
 * order is the order of {@code sources} in the report.
 */
public enum ViewSource {
    DIRECT,
    SEARCH,
    SOCIAL,
    GITHUB,
    INTERNAL,
    OTHER;

    /** Value in the DB and in the API: the lowercase name. */
    public String value() {
        return name().toLowerCase(Locale.ROOT);
    }

    public static ViewSource fromValue(String value) {
        return valueOf(value.toUpperCase(Locale.ROOT));
    }
}
