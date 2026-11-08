package com.blog.fixtures.vi;

/** Vietnamese fixtures for the highlighter tests (diacritic folding, d-stroke, NFC and NFD). */
public final class SearchHighlightVi {

    /** "Learn Java from scratch" */
    public static final String LEARN_JAVA_FROM_SCRATCH = "Học Java từ đầu";

    /** "Learn", capitalised */
    public static final String LEARN_CAP = "Học";

    /** the rest of "Learn Java from scratch" after the first word */
    public static final String JAVA_FROM_SCRATCH_REST = " Java từ đầu";

    /** "The road home, the short road" */
    public static final String WAY_HOME = "Đường về nhà, con đường ngắn";

    /** "Road" with d-stroke, capitalised */
    public static final String ROAD_CAP = "Đường";

    /** "road" with d-stroke */
    public static final String ROAD = "đường";

    /** "QUEUE WAIT and queue wait" in upper and lower case */
    public static final String QUEUE_UPPER_AND_LOWER = "HÀNG ĐỢI và hàng đợi";

    /** "queue wait" with diacritics, used as a query */
    public static final String QUEUE_QUERY = "hàng đợi";

    /** "QUEUE", upper case */
    public static final String QUEUE_UPPER_1 = "HÀNG";

    /** "WAIT", upper case */
    public static final String WAIT_UPPER = "ĐỢI";

    /** "queue", lower case */
    public static final String QUEUE_LOWER_1 = "hàng";

    /** "wait", lower case */
    public static final String WAIT_LOWER = "đợi";

    /** "Lesson: raise an issue" */
    public static final String LESSON_RAISE_ISSUE = "Bài học Đặt vấn đề";

    /** "learn", lower case */
    public static final String LEARN = "học";

    /** "Raise", capitalised */
    public static final String RAISE_CAP = "Đặt";

    /** "They read" */
    public static final String THEY_READ = "Họ đọc";

    /** "They", capitalised */
    public static final String THEY_CAP = "Họ";

    /** " read", the rest of "They read" */
    public static final String READ_REST = " đọc";

    /** "Read more about them" */
    public static final String READ_MORE_ABOUT_THEM = "Đọc thêm về họ";

    /** "they", lower case */
    public static final String THEY = "họ";

    /** "Lesson" */
    public static final String LESSON = "Bài học";

    /** "Student studies lesson" */
    public static final String STUDENT_STUDIES_LESSON = "Học sinh học bài";

    /** "They study" */
    public static final String THEY_STUDY = "Họ học";

    /** "School-learn (learn), "learn"." with punctuation around the word */
    public static final String PUNCTUATED_SCHOOL = "Trường-học (học), \"học\".";

    /** "Queue wait job on GCP: when needed queue" */
    public static final String JOB_QUEUE_SENTENCE = "Hàng đợi job trên GCP: khi nào cần queue";

    /** "Queue", capitalised */
    public static final String QUEUE_CAP = "Hàng";

    /** " wait job on " between two highlights */
    public static final String WAIT_JOB_ON = " đợi job trên ";

    /** ": when needed " between two highlights */
    public static final String WHEN_NEEDED = ": khi nào cần ";

    /** rocket emoji, "Learn fast", rocket emoji, "learn" */
    public static final String ROCKET_LEARN_FAST = "🚀 Học nhanh 🚀 học";

    /** rocket emoji directly followed by "learn" */
    public static final String ROCKET_LEARN = "🚀học";

    /** raw HTML followed by "learn" */
    public static final String IMG_HTML_LEARN = "<img src=x onerror=alert(1)> học";

    /** "Road study" with diacritics */
    public static final String ROAD_STUDY = "Đường học";

    /** the typed prefix of "Road" as highlighted */
    public static final String ROAD_PREFIX = "Đườ";

    /** "System architecture" with diacritics */
    public static final String SYSTEM_ARCHITECTURE = "Kiến trúc hệ thống";

    /** "Architecture" with diacritics */
    public static final String ARCHITECTURE = "Kiến trúc";

    private SearchHighlightVi() {}
}
