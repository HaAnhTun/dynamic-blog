package com.blog.postimport.format;

import com.blog.common.exception.ErrorCode;
import com.blog.siteimport.format.ProfileFile;

/**
 * Turns the raw bytes of an uploaded post file into text the parser can read, or refuses the file. It is the strict
 * decoding of the profile import ({@link ProfileFile}) with the post import's error code and no cap on the length of a
 * line: a Markdown paragraph is often one very long line. The front matter has its own line cap, applied by the parser.
 * Refusals never contain anything from the file (only sizes and line numbers).
 */
public final class PostFile {

    /** 256 KiB per file, the same cap as the profile import. */
    public static final int MAX_BYTES = ProfileFile.MAX_BYTES;

    private PostFile() {}

    /**
     * Strict decode. Throws ApiException: 413 VALIDATION_ERROR when over MAX_BYTES; 400 POST_IMPORT_INVALID_FILE for
     * empty, invalid UTF-8, NUL or other control chars (not TAB/LF/CR), the message naming the line number, never the
     * content. Removes one BOM, turns CRLF and CR into LF, normalizes to NFC.
     */
    public static String decode(byte[] bytes) {
        return ProfileFile.decode(bytes, ErrorCode.POST_IMPORT_INVALID_FILE, ProfileFile.NO_LINE_LIMIT);
    }

    /** Lower case hex SHA-256 of the raw bytes, exactly as uploaded. */
    public static String sha256Hex(byte[] bytes) {
        return ProfileFile.sha256Hex(bytes);
    }

    /** 400 POST_IMPORT_INVALID_FILE unless the name (null-safe, path stripped) ends with ".md" ignoring case. */
    public static void requireMarkdownName(String originalFilename) {
        ProfileFile.requireMarkdownName(originalFilename, ErrorCode.POST_IMPORT_INVALID_FILE);
    }
}
