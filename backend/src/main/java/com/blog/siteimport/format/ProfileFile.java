package com.blog.siteimport.format;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.util.HexFormat;
import java.util.Locale;
import org.springframework.http.HttpStatus;

/**
 * Turns the raw bytes of an uploaded profile file into text the parser can read, or refuses the file. The checks run
 * before any parsing and their messages never contain anything from the file (only sizes and line numbers). The post
 * import reads its files through the same code: it passes its own error code and no line cap (a post body is prose).
 */
public final class ProfileFile {

    public static final int MAX_BYTES = 262_144;
    public static final int MAX_LINE_CHARS = 4_000;
    /** Passed as the line cap when lines may have any length (the size cap still applies). */
    public static final int NO_LINE_LIMIT = Integer.MAX_VALUE;

    private static final char BOM = (char) 0xFEFF;

    private ProfileFile() {}

    /**
     * Strict decode. Throws ApiException: 413 VALIDATION_ERROR when over MAX_BYTES; 400 SITE_IMPORT_INVALID_FILE for
     * empty, invalid UTF-8, NUL or other control chars (not TAB/LF/CR), a line over MAX_LINE_CHARS (message names the
     * line number, never the content). Removes one BOM, turns CRLF and CR into LF, normalizes to NFC.
     */
    public static String decode(byte[] bytes) {
        return decode(bytes, ErrorCode.SITE_IMPORT_INVALID_FILE, MAX_LINE_CHARS);
    }

    /**
     * The same strict decode for another import format: refusals other than the size cap carry {@code invalidFileCode},
     * and a line is refused only when it is longer than {@code maxLineChars} ({@link #NO_LINE_LIMIT} for no line cap).
     */
    public static String decode(byte[] bytes, ErrorCode invalidFileCode, int maxLineChars) {
        if (bytes == null || bytes.length == 0) {
            throw invalid(invalidFileCode, "The file is empty");
        }
        if (bytes.length > MAX_BYTES) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.CONTENT_TOO_LARGE,
                    "The file is larger than " + MAX_BYTES + " bytes");
        }
        String text;
        try {
            text = StandardCharsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes))
                    .toString();
        } catch (CharacterCodingException e) {
            throw invalid(invalidFileCode, "The file is not valid UTF-8 text");
        }
        if (!text.isEmpty() && text.charAt(0) == BOM) {
            text = text.substring(1);
        }
        if (text.isEmpty()) {
            throw invalid(invalidFileCode, "The file is empty");
        }
        String lf = toLineFeeds(text, invalidFileCode);
        String normalized = Normalizer.normalize(lf, Normalizer.Form.NFC);
        if (maxLineChars != NO_LINE_LIMIT) {
            checkLineLengths(normalized, maxLineChars, invalidFileCode);
        }
        return normalized;
    }

    /** Lower case hex SHA-256 of the raw bytes, exactly as uploaded. */
    public static String sha256Hex(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is not available", e);
        }
    }

    /** 400 SITE_IMPORT_INVALID_FILE unless the name (null-safe, path stripped) ends with ".md" ignoring case. */
    public static void requireMarkdownName(String originalFilename) {
        requireMarkdownName(originalFilename, ErrorCode.SITE_IMPORT_INVALID_FILE);
    }

    /** The same name check for another import format: the refusal carries {@code invalidFileCode}. */
    public static void requireMarkdownName(String originalFilename, ErrorCode invalidFileCode) {
        if (originalFilename == null) {
            throw invalid(invalidFileCode, "The file name must end in .md");
        }
        int slash = Math.max(originalFilename.lastIndexOf('/'), originalFilename.lastIndexOf('\\'));
        String name = originalFilename.substring(slash + 1);
        if (!name.toLowerCase(Locale.ROOT).endsWith(".md")) {
            throw invalid(invalidFileCode, "The file name must end in .md");
        }
    }

    /** Rejects control characters (counted per line for the message) and turns CRLF and CR into LF in one pass. */
    private static String toLineFeeds(String text, ErrorCode invalidFileCode) {
        StringBuilder out = new StringBuilder(text.length());
        int line = 1;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\r') {
                out.append('\n');
                if (i + 1 < text.length() && text.charAt(i + 1) == '\n') {
                    i++;
                }
                line++;
            } else if (c == '\n') {
                out.append('\n');
                line++;
            } else if (c != '\t' && Character.getType(c) == Character.CONTROL) {
                throw invalid(invalidFileCode, "The file contains a control character on line " + line);
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    private static void checkLineLengths(String text, int maxLineChars, ErrorCode invalidFileCode) {
        int line = 1;
        int start = 0;
        while (start <= text.length()) {
            int end = text.indexOf('\n', start);
            if (end < 0) {
                end = text.length();
            }
            if (end - start > maxLineChars && text.codePointCount(start, end) > maxLineChars) {
                throw invalid(invalidFileCode, "Line " + line + " is longer than " + maxLineChars + " characters");
            }
            line++;
            start = end + 1;
        }
    }

    private static ApiException invalid(ErrorCode code, String message) {
        return new ApiException(code, HttpStatus.BAD_REQUEST, message);
    }
}
