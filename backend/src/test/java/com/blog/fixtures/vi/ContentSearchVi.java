package com.blog.fixtures.vi;

/** Vietnamese text for the accent-insensitive post search tests (vi_unaccent, NFC and NFD matching). */
public final class ContentSearchVi {

    private ContentSearchVi() {}

    /** A title about recursion, searched with and without accents. */
    public static final String RECURSION_TITLE = "Nghiên cứu đệ quy";

    /** The accented query that must find the recursion title. */
    public static final String RECURSION_QUERY = "đệ quy";

    /** Title prefix "learn Rust", the accented word is found by the unaccented query. */
    public static final String LEARN_RUST_PREFIX = "Học Rust ";

    /** Title prefix "the way home", starts with the capital d-with-stroke. */
    public static final String ROAD_HOME_PREFIX = "Đường về nhà ";

    /** Title prefix "the road", lowercase d-with-stroke. */
    public static final String THE_ROAD_PREFIX = "Con đường ";

    /** Accented query "road" (lowercase) followed by a space. */
    public static final String ROAD_QUERY_PREFIX = "đường ";

    /** Title prefix "the road of learning". */
    public static final String ROAD_OF_LEARNING_PREFIX = "Đường học ";

    /** Uppercase accented query "learn" followed by a space. */
    public static final String LEARN_UPPER_PREFIX = "HỌC ";

    /** Uppercase accented query "road" followed by a space. */
    public static final String ROAD_UPPER_PREFIX = "ĐƯỜNG ";

    /** Title prefix "learning path", the accented word is searched in NFD form. */
    public static final String LEARNING_PATH_PREFIX = "Lộ trình học ";

    /** The accented word "learn" (NFC), decomposed to NFD by the test. */
    public static final String LEARN = "học";

    /** Title prefix "rice noodles with grilled pork", decomposed to NFD by the test. */
    public static final String NOODLES_PREFIX = "Bún chả ";

    /** The same prefix in lowercase, used as the accented query. */
    public static final String NOODLES_QUERY_PREFIX = "bún chả ";

    /** Text fed to to_tsvector: "road of learning". */
    public static final String ROAD_OF_LEARNING = "Đường học";

    /** Text fed to plainto_tsquery: uppercase "learn". */
    public static final String LEARN_UPPER = "HỌC";

    /** Text fed to to_tsvector: a hyphenated place name plus a word with a digit. */
    public static final String HYPHEN_AND_NUMWORD = "Đà-Nẵng học2";

    /** Title prefix "road of learning number" for the filtered, paginated search. */
    public static final String ROAD_OF_LEARNING_NUMBER_PREFIX = "Đường học số ";

    /** Title prefix "road of learning outside the category". */
    public static final String ROAD_OF_LEARNING_OUTSIDE_PREFIX = "Đường học ngoài chuyên mục ";

    /** Uppercase accented query "road of learning". */
    public static final String ROAD_OF_LEARNING_UPPER = "ĐƯỜNG HỌC";
}
