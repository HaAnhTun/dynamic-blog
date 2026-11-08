package com.blog.common.text;

import java.util.regex.Pattern;

/**
 * Normalizes text submitted by readers: comment content ({@link #clean}) and display names taken from GitHub
 * ({@link #cleanName}).
 *
 * It removes what others cannot see yet can still change how the text appears: control characters, zero-width
 * characters, and bidirectional text control characters (bidi), which are used for spoofing (inserting U+202E between
 * "image" and "gpj.exe" makes the whole string display as "imageexe.jpg"). It keeps ZWNJ (U+200C) and ZWJ (U+200D):
 * combined emoji sequences and some scripts need them. This set of invisible characters has a copy in the frontend
 * ({@code lib/comment-content.ts}); change one side and you must change the other.
 *
 * It does not touch HTML: content is stored verbatim and only ever displayed as text, so {@code <script>} is harmless
 * and must be kept exactly as the writer typed it. The length and "at least one visible character" are the caller's
 * job (CommentContent).
 */
public final class UserText {

    /** Three or more consecutive line breaks. */
    private static final Pattern EXCESS_BLANK_LINES = Pattern.compile("\n{3,}");

    private UserText() {}

    /**
     * Normalizes multi-line content, in exactly this order:
     * <ol>
     *   <li>CRLF and CR become LF;</li>
     *   <li>remove C0/C1 control characters except LF and tab, NUL included (Postgres rejects it in text);</li>
     *   <li>remove invisible characters and text-direction controls;</li>
     *   <li>{@code strip()} both ends;</li>
     *   <li>collapse three or more consecutive line breaks into two.</li>
     * </ol>
     * Inner whitespace is kept, so pasted code keeps its indentation.
     *
     * @return the normalized string; an empty string when {@code raw} is null
     */
    public static String clean(String raw) {
        if (raw == null) {
            return "";
        }
        String unified = raw.replace("\r\n", "\n").replace('\r', '\n');
        StringBuilder kept = new StringBuilder(unified.length());
        unified.codePoints()
                .filter(cp -> cp == '\n' || cp == '\t' || !(Character.isISOControl(cp) || isInvisible(cp)))
                .forEach(kept::appendCodePoint);
        return EXCESS_BLANK_LINES.matcher(kept.toString().strip()).replaceAll("\n\n");
    }

    /**
     * Normalizes a single-line display name: removes every control and invisible character (leaving no whitespace in
     * their place), collapses every run of whitespace, including line breaks, tabs and non-breaking spaces, into one
     * space, and trims both ends.
     *
     * @return the normalized name; an empty string when {@code raw} is null or nothing is left, so the caller uses the
     *         login instead
     */
    public static String cleanName(String raw) {
        if (raw == null) {
            return "";
        }
        StringBuilder out = new StringBuilder(raw.length());
        boolean pendingSpace = false;
        for (int i = 0; i < raw.length(); ) {
            int cp = raw.codePointAt(i);
            i += Character.charCount(cp);
            if (Character.isWhitespace(cp) || Character.isSpaceChar(cp)) {
                pendingSpace = true;
            } else if (!Character.isISOControl(cp) && !isInvisible(cp)) {
                if (pendingSpace && !out.isEmpty()) {
                    out.append(' ');
                }
                pendingSpace = false;
                out.appendCodePoint(cp);
            }
        }
        return out.toString();
    }

    private static final char ELLIPSIS = (char) 0x2026;

    /** The longest piece of caller-supplied text a log line carries ({@link #forLog}). */
    public static final int LOG_TEXT_MAX = 300;

    /**
     * Makes text that a caller can influence safe to write into a log line: every control character (a line break
     * included), the line and paragraph separators and every invisible or text-direction character become U+FFFD, so
     * one event stays one line and nobody can forge another; the result is cut at {@value #LOG_TEXT_MAX} characters
     * (an ellipsis marks the cut). Use it for a value that was typed by someone: an exception message that repeats a
     * name, a slug, a title. A line that never carries such a value does not need it.
     *
     * @return the safe text; {@code "-"} when {@code raw} is null
     */
    public static String forLog(String raw) {
        if (raw == null) {
            return "-";
        }
        StringBuilder out = new StringBuilder(Math.min(raw.length(), LOG_TEXT_MAX + 1));
        int kept = 0;
        for (int i = 0; i < raw.length(); ) {
            int cp = raw.codePointAt(i);
            i += Character.charCount(cp);
            if (kept == LOG_TEXT_MAX) {
                out.append(ELLIPSIS);
                break;
            }
            out.appendCodePoint(isLineOrControl(cp) || isInvisible(cp) ? 0xFFFD : cp);
            kept++;
        }
        return out.toString();
    }

    /** A control character, or the Unicode line and paragraph separator that some log viewers show as a break. */
    private static boolean isLineOrControl(int cp) {
        return Character.isISOControl(cp) || cp == 0x2028 || cp == 0x2029;
    }

    /**
     * U+00AD (soft hyphen), U+061C (Arabic letter mark, a direction mark like U+200F), U+200B (zero-width space),
     * U+200E and U+200F (left-to-right and right-to-left marks), U+202A-U+202E (direction embeddings and overrides),
     * U+2060-U+2064 (word joiner and the invisible operators), U+2066-U+2069 (direction isolates), U+FEFF (BOM). That
     * covers every text-direction control character (Bidi_Control) in Unicode. U+200C and U+200D are deliberately not
     * included.
     */
    public static boolean isInvisible(int cp) {
        return cp == 0x00AD
                || cp == 0x061C
                || cp == 0x200B
                || cp == 0x200E
                || cp == 0x200F
                || (cp >= 0x202A && cp <= 0x202E)
                || (cp >= 0x2060 && cp <= 0x2064)
                || (cp >= 0x2066 && cp <= 0x2069)
                || cp == 0xFEFF;
    }
}
