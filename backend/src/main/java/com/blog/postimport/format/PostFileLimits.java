package com.blog.postimport.format;

import com.blog.post.dto.PostLimits;

/**
 * The caps of the post file format. The values of a key respect the limits the stored fields have in the editor (title and
 * slug 255, category 255, tag 100, language 8); the other caps keep a hostile file cheap to read. Counted in UTF-16 code
 * units like the editor's request validation, except the length of a front matter line, which is counted in characters
 * (code points).
 */
public final class PostFileLimits {

    /** Lines between the two fences, comments and blank lines included. */
    public static final int MAX_FRONT_MATTER_LINES = 100;

    /** Characters in one front matter line. The body has no line cap. */
    public static final int MAX_FRONT_MATTER_LINE_CHARS = 4_000;

    public static final int MAX_TAGS = 20;

    /** Problems listed per file; when there are more, the last one says so. */
    public static final int MAX_PROBLEMS = 100;

    /** Ignored keys listed per file; the count of all of them is kept. */
    public static final int MAX_IGNORED = 50;

    public static final int MAX_TITLE_CHARS = 255;
    /** The excerpt of the editor and of the database (issue 013): a longer one is a problem of the file, not a failed write. */
    public static final int MAX_EXCERPT_CHARS = PostLimits.EXCERPT_MAX;

    public static final int MAX_SLUG_CHARS = 255;
    public static final int MAX_CATEGORY_CHARS = 255;
    public static final int MAX_TAG_CHARS = 100;
    public static final int MAX_LANGUAGE_CHARS = 8;
    public static final int MAX_SERIES_CHARS = 255;
    public static final int MAX_SERIES_DESCRIPTION_CHARS = 2_000;

    /** The highest declared part of a series (the lowest is 1). */
    public static final int MAX_SERIES_PART = 1_000;

    /** An unknown key is named in the answer only when it is at most this long (and made of plain characters). */
    public static final int MAX_ECHOED_KEY_CHARS = 32;

    // --- One upload (the request of a preview or an apply) -------------------------------------------------

    /** Post files in one import. */
    public static final int MAX_FILES = 20;

    /**
     * Bytes of all the files of one import together. Twenty files of {@link PostFile#MAX_BYTES} would be 5 MiB, more than the
     * frontend server action accepts (5 MiB with its other fields), so for large files this total binds first.
     */
    public static final int MAX_TOTAL_BYTES = 4 * 1024 * 1024;

    /** Problems listed in one answer; a file in error always keeps its first problem. */
    public static final int MAX_PROBLEMS_PER_RESPONSE = 200;

    /** Names an import may create: categories and tags that do not exist yet. */
    public static final int MAX_NEW_CATEGORIES = 20;

    public static final int MAX_NEW_TAGS = 50;

    /** Series an import may create, administrators only: a series is created by its name, once per name. */
    public static final int MAX_NEW_SERIES = 10;

    /** Longest before or after text of a title, description or category in a preview. */
    public static final int MAX_CHANGE_TEXT_CHARS = 200;

    // --- A ZIP package (one article and its images in one .zip) --------------------------------------------

    /**
     * Bytes of one package as uploaded. The same figure as {@link #MAX_TOTAL_BYTES}: a package is one file, and the frontend
     * server action accepts 5 MiB with its other fields.
     */
    public static final int MAX_PACKAGE_BYTES = MAX_TOTAL_BYTES;

    /** Entries (files and folders) in one package. */
    public static final int MAX_PACKAGE_ENTRIES = 40;

    /** Bytes of one image of a package, as uploaded (the media pipeline then re-encodes it). */
    public static final int MAX_PACKAGE_ASSET_BYTES = 4 * 1024 * 1024;

    /** Bytes of everything in the packages of one request, unpacked: the memory a hostile upload can make the reader hold. */
    public static final long MAX_PACKAGE_UNCOMPRESSED_BYTES = 16L * 1024 * 1024;

    /** Unpacked bytes over packed bytes: more than this is a decompression bomb. */
    public static final int MAX_PACKAGE_COMPRESSION_RATIO = 100;

    /** Entries smaller than this are never judged by their compression ratio: they cost nothing, and a run of one character packs very well. */
    public static final int MIN_BYTES_FOR_RATIO_CHECK = 64 * 1024;

    /** Characters in the name of one package entry. */
    public static final int MAX_PACKAGE_NAME_CHARS = 200;

    /** A path the author wrote is named in an answer to the uploader cut to this length. */
    public static final int MAX_ECHOED_PATH_CHARS = 200;

    private PostFileLimits() {}
}
