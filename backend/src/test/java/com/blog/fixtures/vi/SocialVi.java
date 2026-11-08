package com.blog.fixtures.vi;

/** Non-ASCII text for newsletter mail encoding and address validation tests. */
public final class SocialVi {

    private SocialVi() {}

    /** A sender address with a non-ASCII local part, which must be refused as invalid. */
    public static final String NON_ASCII_FROM = "tin-mới@example.com";

    /** A mail subject with diacritics, to prove the UTF-8 header encoding round trip. */
    public static final String MAIL_SUBJECT = "Bài mới: Spring Boot 4";

    /** A mail body with diacritics, to prove the UTF-8 body encoding round trip. */
    public static final String MAIL_BODY = "Nội dung thư\nĐọc bài: https://blog.example.com/posts/spring-boot-4\n";
}
