package com.blog.fixtures.vi;

/** Vietnamese display names and handles whose diacritics drive public slug generation and validation. */
public final class IdentityViNames {

    private IdentityViNames() {}

    /** A three-word name with several diacritics and the letter d-stroke; slug "nguyen-van-duc". */
    public static final String NGUYEN_VAN_DUC = "Nguyễn Văn Đức";

    /** A name with d-stroke in lower and upper case; slug "duong-di". */
    public static final String DUONG_DI = "đường ĐI";

    /** A name with a capital A with acute accent and a capital d-stroke; slug "tran-thi-anh-dao". */
    public static final String TRAN_THI_ANH_DAO = "Trần Thị Ánh Đào";

    /** A name with dashes, extra spaces and uppercase diacritics; slug "duong-dan". */
    public static final String DUONG_DAN_PADDED = "  --ĐƯỜNG   dẫn--  ";

    /** A two-word display name; slug "ten-khac". */
    public static final String TEN_KHAC = "Tên Khác";

    /** A lone d-stroke: not a valid slug because slugs are ASCII only. */
    public static final String D_STROKE = "đ";

    /** A lone o with horn: not a valid slug because slugs are ASCII only. */
    public static final String O_HORN = "ơ";
}
