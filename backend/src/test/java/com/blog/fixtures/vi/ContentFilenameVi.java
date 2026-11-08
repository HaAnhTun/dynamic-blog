package com.blog.fixtures.vi;

/** Upload file names with diacritics, which the file name sanitizer must keep. */
public final class ContentFilenameVi {

    private ContentFilenameVi() {}

    /** A Windows path whose folder has diacritics; only the file name is kept. */
    public static final String WINDOWS_PATH = "C:\\Users\\user\\Ảnh\\IMG_0001.JPG";

    /** A Unix path whose file name has diacritics and a space. */
    public static final String UNIX_PATH = "/home/user/ảnh bìa.png";

    /** The file name kept from the Unix path. */
    public static final String UNIX_NAME = "ảnh bìa.png";

    /** A name with surrounding spaces and diacritics. */
    public static final String PADDED = "  khoảng trắng.webp  ";

    /** The trimmed name. */
    public static final String PADDED_TRIMMED = "khoảng trắng.webp";

    /** A name with a tab, a newline and a DEL control character between diacritic letters. */
    public static final String WITH_CONTROL_CHARS = "tab\tvà\nxuống\u007fdòng.jpg";

    /** The same name with the control characters removed. */
    public static final String WITHOUT_CONTROL_CHARS = "tabvàxuốngdòng.jpg";
}
