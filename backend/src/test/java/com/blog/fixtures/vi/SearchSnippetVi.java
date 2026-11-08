package com.blog.fixtures.vi;

/** Vietnamese fixtures of the Meilisearch snippet and emoji test (d-stroke, stacked diacritics, surrogate pairs). */
public final class SearchSnippetVi {

    /** Markdown heading "Introduction" followed by a blank line */
    public static final String INTRO_HEADING = "## Mở đầu\n\n";

    /** "Opening sentence number " prefix */
    public static final String SENTENCE_NUMBER_PREFIX = "Câu mở đầu số ";

    /**  " talks about Hanoi and its streets. " suffix */
    public static final String ABOUT_HANOI = " nói về Hà Nội và những con đường. ";

    /** blank line then "Road " with capital d-stroke */
    public static final String ROAD_START = "\n\nĐường ";

    /** " go to school " between two emoji */
    public static final String GO_TO_SCHOOL = " đi học ";

    /** " every day, priority " right before the marker word */
    public static final String EVERY_DAY_PRIORITY = " mỗi ngày, ưu tiên ";

    /** " here, `json.loads` " with inline code after the marker */
    public static final String HERE_CODE = " ở đây, `json.loads` ";

    /** eth and d-stroke letters in both cases */
    public static final String D_STROKE_VARIANTS = " Ð ð Đ đ ";

    /** letters carrying stacked diacritics */
    public static final String STACKED_DIACRITICS = "ả ẫ ự ỹ ";

    /** "Closing sentence number " prefix */
    public static final String CLOSING_NUMBER_PREFIX = "Câu kết số ";

    /** " also has road and " suffix */
    public static final String ALSO_HAS_ROAD = " cũng có đường và ";

    /** "Excerpt " category title prefix */
    public static final String EXCERPT_CATEGORY_PREFIX = "Trích ";

    /** "Notes " title prefix */
    public static final String NOTES_PREFIX = "Ghi chép ";

    /**  " street " between the emoji and the marker prefix in the title */
    public static final String STREET_BETWEEN = " đường phố ";

    /** "Unrelated summary", must never appear in the snippet */
    public static final String UNRELATED_SUMMARY = "Tóm tắt không liên quan";

    /** "priority" with diacritics, expected inside the snippet */
    public static final String PRIORITY = "ưu tiên";

    /** query "road " with d-stroke */
    public static final String QUERY_ROAD = "đường ";

    /** query "pri " with u-horn */
    public static final String QUERY_PRIORITY_SHORT = "ưu ";

    /** query of a lone d-stroke */
    public static final String QUERY_D_STROKE = "đ ";

    /** query of a lone capital eth */
    public static final String QUERY_ETH = "Ð ";

    /** query of a lone u with horn and dot */
    public static final String QUERY_U_DOT = "ự ";

    /** query "street" with d-stroke */
    public static final String QUERY_ROAD_STREET = "đường phố";

    /** query "go to school" with diacritics */
    public static final String QUERY_GO_TO_SCHOOL = "đi học";

    /** query "street " followed by the marker prefix */
    public static final String QUERY_ROAD_STREET_SPACE = "đường phố ";

    private SearchSnippetVi() {}
}
