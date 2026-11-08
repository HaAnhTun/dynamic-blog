package com.blog.search.service;

import com.blog.search.dto.Segment;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Keyword highlighting, the Java version of {@code frontend/lib/highlight.ts}: splits a string into matching and
 * non-matching segments ({@link Segment}) that concatenate back to the original string. Returns data, not HTML: the
 * frontend renders each segment as a text node, so a string containing {@code <img onerror>} is just text.
 *
 * Matches the way Postgres matches ({@code vi_unaccent}): folds each code point (NFD, drop combining marks, d-stroke to d,
 * lowercase) and remembers its original position; a word is a run of letters and digits. By default whole words match
 * (like {@code plainto_tsquery}); with {@code prefix} it is enough to start a word, for the sources filtered in place
 * (topics, series, authors, case studies, pages). No regex is built from the query: the query is only split into words
 * and searched with {@code indexOf}.
 */
public final class Highlighter {

    private Highlighter() {}

    /** Every word of {@code query} matches somewhere in {@code text} (AND). No words: no match. */
    public static boolean matchesQuery(String text, String query, boolean prefix) {
        List<String> terms = termsOf(query);
        if (terms.isEmpty()) {
            return false;
        }
        String folded = foldWithOrigin(text).folded();
        return terms.stream()
                .allMatch(term -> !rangesOf(folded, List.of(term), prefix).isEmpty());
    }

    /**
     * {@code text} split into consecutive segments, in order; concatenated they give {@code text} again. A query with no
     * words makes the whole string one non-matching segment; an empty string has no segments.
     */
    public static List<Segment> segments(String text, String query, boolean prefix) {
        if (text.isEmpty()) {
            return List.of();
        }
        List<String> terms = termsOf(query);
        if (terms.isEmpty()) {
            return List.of(new Segment(text, false));
        }
        Folded folded = foldWithOrigin(text);
        List<int[]> ranges = rangesOf(folded.folded(), terms, prefix);
        if (ranges.isEmpty()) {
            return List.of(new Segment(text, false));
        }

        List<Segment> segments = new ArrayList<>();
        int length = folded.folded().length();
        int cursor = 0;
        for (int[] range : ranges) {
            int start = range[0];
            int end = range[1];
            int origStart = folded.from()[start];
            // Extend to the start of the next folded character: a code point in between is a combining mark (NFD) of
            // the last letter of the match.
            int origEnd = end < length ? Math.max(folded.to()[end - 1], folded.from()[end]) : text.length();
            // Two keywords overlap ("sp", "spring" on a prefix match): drop the overlap.
            if (origStart < cursor) {
                continue;
            }
            if (origStart > cursor) {
                segments.add(new Segment(text.substring(cursor, origStart), false));
            }
            segments.add(new Segment(text.substring(origStart, origEnd), true));
            cursor = origEnd;
        }
        if (cursor < text.length()) {
            segments.add(new Segment(text.substring(cursor), false));
        }
        return segments;
    }

    /** Folds a string: NFD, drop combining marks, d-stroke to d, lowercase. */
    static String fold(String text) {
        String decomposed = Normalizer.normalize(text, Normalizer.Form.NFD);
        StringBuilder out = new StringBuilder(decomposed.length());
        decomposed
                .codePoints()
                .filter(cp -> !isMark(cp))
                // U+0111 and U+0110 are the d-stroke letters; they fold to plain d.
                .forEach(cp -> out.appendCodePoint(cp == '\u0111' || cp == '\u0110' ? 'd' : cp));
        return out.toString().toLowerCase(Locale.ROOT);
    }

    /** The folded terms, without repeats, in order of appearance. Folds code point by code point, like the highlighted string. */
    static List<String> termsOf(String query) {
        Set<String> terms = new LinkedHashSet<>();
        StringBuilder current = new StringBuilder();
        query.codePoints()
                .forEach(original -> fold(Character.toString(original))
                        .codePoints()
                        .forEach(cp -> {
                            if (isWordChar(cp)) {
                                current.appendCodePoint(cp);
                            } else {
                                if (!current.isEmpty()) {
                                    terms.add(current.toString());
                                }
                                current.setLength(0);
                            }
                        }));
        if (!current.isEmpty()) {
            terms.add(current.toString());
        }
        return List.copyOf(terms);
    }

    /**
     * The folded string, with, for each of its code units, the start ({@code from}) and end ({@code to}) position in the
     * original string of the code point that produced it.
     */
    private static Folded foldWithOrigin(String text) {
        StringBuilder folded = new StringBuilder(text.length());
        int[] from = new int[text.length() * 2];
        int[] to = new int[text.length() * 2];
        int size = 0;
        int offset = 0;
        while (offset < text.length()) {
            int cp = text.codePointAt(offset);
            int width = Character.charCount(cp);
            String piece = fold(text.substring(offset, offset + width));
            for (int i = 0; i < piece.length(); i++) {
                if (size == from.length) {
                    from = Arrays.copyOf(from, size * 2);
                    to = Arrays.copyOf(to, size * 2);
                }
                from[size] = offset;
                to[size] = offset + width;
                size++;
            }
            folded.append(piece);
            offset += width;
        }
        return new Folded(folded.toString(), from, to);
    }

    /** Match ranges [start, end) on the folded string, ordered by start (stable sort). */
    private static List<int[]> rangesOf(String folded, List<String> terms, boolean prefix) {
        List<int[]> ranges = new ArrayList<>();
        for (String term : terms) {
            for (int at = folded.indexOf(term); at != -1; at = folded.indexOf(term, at + 1)) {
                int end = at + term.length();
                if (!isWordBefore(folded, at) && (prefix || !isWordAt(folded, end))) {
                    ranges.add(new int[] {at, end});
                }
            }
        }
        ranges.sort(Comparator.comparingInt(range -> range[0]));
        return ranges;
    }

    /** Whether the code point starting at {@code index} (including a surrogate pair) is a word character. */
    private static boolean isWordAt(String text, int index) {
        return index < text.length() && isWordChar(text.codePointAt(index));
    }

    /** Whether the code point ending right before {@code index} is a word character. */
    private static boolean isWordBefore(String text, int index) {
        if (index <= 0) {
            return false;
        }
        char low = text.charAt(index - 1);
        int start = Character.isLowSurrogate(low) && index >= 2 ? index - 2 : index - 1;
        return isWordAt(text, start);
    }

    /** A letter or digit ({@code [\p{L}\p{N}]}), following the Postgres word splitter. */
    private static boolean isWordChar(int cp) {
        return switch (Character.getType(cp)) {
            case Character.UPPERCASE_LETTER,
                    Character.LOWERCASE_LETTER,
                    Character.TITLECASE_LETTER,
                    Character.MODIFIER_LETTER,
                    Character.OTHER_LETTER,
                    Character.DECIMAL_DIGIT_NUMBER,
                    Character.LETTER_NUMBER,
                    Character.OTHER_NUMBER -> true;
            default -> false;
        };
    }

    /** A combining mark ({@code \p{M}}), what gets dropped when folding. */
    private static boolean isMark(int cp) {
        int type = Character.getType(cp);
        return type == Character.NON_SPACING_MARK
                || type == Character.ENCLOSING_MARK
                || type == Character.COMBINING_SPACING_MARK;
    }

    private record Folded(String folded, int[] from, int[] to) {}
}
