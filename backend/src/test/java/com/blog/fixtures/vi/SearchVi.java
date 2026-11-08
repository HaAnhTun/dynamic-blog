package com.blog.fixtures.vi;

/** Vietnamese words used by the search tests that check how letters and diacritics are treated. */
public final class SearchVi {

    /** "street" with a d-stroke, a letter outside the ASCII range and not a valid id or filter value. */
    public static final String STREET = "đường";

    /** "machine learning" with diacritics, a query that must reach the engine unchanged. */
    public static final String MACHINE_LEARNING = "học máy";

    /** "learn" with diacritics, a query that has letters and so is not an empty query. */
    public static final String LEARN = "học";

    /** "Architecture " (with diacritics) and a trailing space, a category title prefix. */
    public static final String ARCHITECTURE_PREFIX = "Kiến trúc ";

    /** "Post about architecture " (with diacritics) and a trailing space, a post title prefix. */
    public static final String ARCHITECTURE_POST_PREFIX = "Bài kiến trúc ";

    /** "Architecture", the first word of the category title, expected as a highlighted match. */
    public static final String ARCHITECTURE_FIRST_WORD = "Kiến";

    private SearchVi() {}
}
