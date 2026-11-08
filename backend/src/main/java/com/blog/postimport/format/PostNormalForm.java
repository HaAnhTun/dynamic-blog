package com.blog.postimport.format;

import java.text.Normalizer;

/**
 * The normal form of a post file value: how the "Download .md" writer writes it, and so the form in which a value read from a
 * file and the stored value are compared. Every function is a single pass over the text (no regular expression), and the
 * line breaks and the whitespace are the sets the TypeScript writer ({@code frontend/lib/post-markdown.ts}) uses, so the two
 * agree on what a file value is.
 */
public final class PostNormalForm {

    private static final char EM_DASH = (char) 0x2014;
    private static final int MIN_HYPHEN_RUN = 3;

    private PostNormalForm() {}

    /**
     * A title, description or category name as the download writes it: NFC, every run of line breaks (with the spaces and
     * tabs around it) one space, every run of three or more hyphens one em dash, trimmed. Null is the empty string.
     */
    public static String line(String value) {
        if (value == null) {
            return "";
        }
        String nfc = Normalizer.normalize(value, Normalizer.Form.NFC);
        return strip(hyphensToDash(breaksToSpaces(nfc)));
    }

    /**
     * A tag name as the download writes it: {@link #line}, then each comma becomes a space (tags are separated by commas) and
     * every run of whitespace one space.
     */
    public static String tag(String name) {
        String flat = line(name);
        StringBuilder out = new StringBuilder(flat.length());
        boolean space = false;
        for (int i = 0; i < flat.length(); i++) {
            char c = flat.charAt(i);
            if (c == ',' || isWhitespace(c)) {
                space = true;
            } else {
                if (space) {
                    out.append(' ');
                }
                space = false;
                out.append(c);
            }
        }
        return strip(out.toString());
    }

    /**
     * A post body: NFC, LF line endings, leading blank lines dropped, trailing line breaks ignored (the download adds one when
     * the body has none). Null is the empty string.
     */
    public static String content(String value) {
        if (value == null) {
            return "";
        }
        String text = Normalizer.normalize(value, Normalizer.Form.NFC);
        text = text.replace("\r\n", "\n").replace('\r', '\n');
        int start = 0;
        while (start < text.length()) {
            int end = text.indexOf('\n', start);
            if (end < 0) {
                end = text.length();
            }
            if (!text.substring(start, end).isBlank()) {
                break;
            }
            start = end + 1;
        }
        int end = text.length();
        while (end > start && text.charAt(end - 1) == '\n') {
            end--;
        }
        return start >= end ? "" : text.substring(start, end);
    }

    /** Trims the same characters as JavaScript's {@code String.prototype.trim}, which the TypeScript writer uses. */
    public static String strip(String value) {
        int start = 0;
        int end = value.length();
        while (start < end && isWhitespace(value.charAt(start))) {
            start++;
        }
        while (end > start && isWhitespace(value.charAt(end - 1))) {
            end--;
        }
        return value.substring(start, end);
    }

    /** The characters Python's {@code str.splitlines()} treats as line breaks, which the developer script reads files with. */
    private static boolean isLineBreak(char c) {
        return switch (c) {
            case 0x0A, 0x0B, 0x0C, 0x0D, 0x1C, 0x1D, 0x1E, 0x85, 0x2028, 0x2029 -> true;
            default -> false;
        };
    }

    private static boolean isSpaceOrTab(char c) {
        return c == ' ' || c == '\t';
    }

    /** JavaScript white space: the line breaks above, tab, space and every other space separator, the byte order mark. */
    private static boolean isWhitespace(char c) {
        return isLineBreak(c)
                || c == '\t'
                || c == 0xFEFF
                || c == ' '
                || Character.getType(c) == Character.SPACE_SEPARATOR;
    }

    /** A run of line breaks, and the spaces and tabs next to it, is one space. Spaces that touch no line break stay. */
    private static String breaksToSpaces(String text) {
        StringBuilder out = new StringBuilder(text.length());
        int i = 0;
        while (i < text.length()) {
            char c = text.charAt(i);
            if (!isLineBreak(c) && !isSpaceOrTab(c)) {
                out.append(c);
                i++;
                continue;
            }
            int blanksEnd = i;
            while (blanksEnd < text.length() && isSpaceOrTab(text.charAt(blanksEnd))) {
                blanksEnd++;
            }
            int breaksEnd = blanksEnd;
            while (breaksEnd < text.length() && isLineBreak(text.charAt(breaksEnd))) {
                breaksEnd++;
            }
            if (breaksEnd == blanksEnd) {
                out.append(text, i, blanksEnd);
                i = blanksEnd;
                continue;
            }
            while (breaksEnd < text.length() && isSpaceOrTab(text.charAt(breaksEnd))) {
                breaksEnd++;
            }
            out.append(' ');
            i = breaksEnd;
        }
        return out.toString();
    }

    private static String hyphensToDash(String text) {
        StringBuilder out = new StringBuilder(text.length());
        int i = 0;
        while (i < text.length()) {
            char c = text.charAt(i);
            if (c != '-') {
                out.append(c);
                i++;
                continue;
            }
            int end = i;
            while (end < text.length() && text.charAt(end) == '-') {
                end++;
            }
            if (end - i >= MIN_HYPHEN_RUN) {
                out.append(EM_DASH);
            } else {
                out.append(text, i, end);
            }
            i = end;
        }
        return out.toString();
    }
}
