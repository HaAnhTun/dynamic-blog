package com.blog.fixtures.vi;

/** Vietnamese text constants for the tests of text cleaning, LIKE patterns, slugs and login validation. */
public final class IdentityViText {

    private IdentityViText() {}

    // Mixed-case display name used to prove that LIKE patterns lowercase Vietnamese letters.
    public static final String READER_TITLE = "Độc Giả";
    // The same name in lower case, the expected LIKE body.
    public static final String READER_LOWER = "độc giả";
    // First half of the identifier "tên_biến" (name).
    public static final String WORD_TEN = "tên";
    // Second half of the identifier "tên_biến" (variable).
    public static final String WORD_BIEN = "biến";
    // First word of "bình luận" (comment).
    public static final String WORD_BINH = "bình";
    // Second word of "bình luận" (comment).
    public static final String WORD_LUAN = "luận";
    // The word "một" (one) used in line-ending normalization.
    public static final String WORD_MOT = "một";
    // The word "bốn" (four) used in line-ending normalization.
    public static final String WORD_BON = "bốn";
    // The phrase "xem ảnh" (see the picture).
    public static final String SEE_PICTURE = "xem ảnh";
    // The phrase "nội dung" (content).
    public static final String CONTENT = "nội dung";
    // The phrase "ví dụ:" (for example:).
    public static final String FOR_EXAMPLE = "ví dụ:";
    // The phrase "hết  rồi" (that is all) with two inner spaces.
    public static final String THAT_IS_ALL = "hết  rồi";
    // Family name "Nguyễn" with a circumflex and a tilde.
    public static final String NAME_NGUYEN = "Nguyễn";
    // Middle name "Văn" with a breve.
    public static final String NAME_VAN = "Văn";
    // Full name "Lê Thị Ánh " (with a trailing space) for the emoji and diacritics test.
    public static final String NAME_LE_THI_ANH = "Lê Thị Ánh ";
    // GitHub login candidate with diacritics, which the login pattern must reject.
    public static final String LOGIN_WITH_DIACRITICS = "ểvì";
    // Secret with Vietnamese letters: 26 characters but 37 UTF-8 bytes.
    public static final String SECRET_VIETNAMESE = "đây-là-mật-khẩu-tiếng-việt";
    // Slug input: a tutorial title with diacritics.
    public static final String SLUG_TITLE_GUIDE = "Hướng dẫn Spring Boot cơ bản";
    // Slug input: a title with symbols and diacritics.
    public static final String SLUG_TITLE_SYMBOLS = "Redis & Spring Boot: một góc nhìn!!";
    // Slug input: a street name with an uppercase D-stroke.
    public static final String SLUG_STREET_UPPER = "Đường Nguyễn Huệ";
    // Slug input: a phrase starting with a lowercase d-stroke.
    public static final String SLUG_STREET_LOWER = "đường phố";
    // Slug input: "Học Spring" (learn Spring).
    public static final String SLUG_LEARN_SPRING = "Học Spring";
}
