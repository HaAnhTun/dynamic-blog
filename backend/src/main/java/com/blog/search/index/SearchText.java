package com.blog.search.index;

import com.blog.search.dto.Segment;
import java.util.ArrayList;
import java.util.List;

/**
 * Meilisearch highlight marks are two private-use characters (sentinels, U+E000 opens, U+E001 closes), not {@code <mark>}:
 * the answer is turned into {@link Segment}s in the backend, so no HTML goes over the wire. Every text field has the whole
 * private-use range U+E000-U+F8FF stripped before indexing, so a post cannot inject a fake mark.
 */
public final class SearchText {

    public static final char HIGHLIGHT_PRE = (char) 0xE000;
    public static final char HIGHLIGHT_POST = (char) 0xE001;
    /** Crop marker of a snippet (U+2026), the Meilisearch default; set explicitly in the query. */
    public static final String CROP_MARKER = String.valueOf((char) 0x2026);

    private SearchText() {}

    /** {@code text} with no character in U+E000-U+F8FF left; null stays null. */
    public static String stripPrivateUse(String text) {
        if (text == null) {
            return null;
        }
        StringBuilder out = null;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (isPrivateUse(c)) {
                if (out == null) {
                    out = new StringBuilder(text.length()).append(text, 0, i);
                }
            } else if (out != null) {
                out.append(c);
            }
        }
        return out == null ? text : out.toString();
    }

    /**
     * The {@code _formatted} string of Meilisearch into segments: what is between the open and close marks is a match. A
     * stray mark (a close without an open, an open without a close) yields no match segment beyond its own text; any other
     * remaining private-use character is dropped. Adjacent segments of the same kind are merged, empty segments dropped:
     * concatenating the segments gives exactly the string with the marks removed.
     */
    public static List<Segment> segments(String formatted) {
        List<Segment> segments = new ArrayList<>();
        if (formatted == null || formatted.isEmpty()) {
            return segments;
        }
        StringBuilder current = new StringBuilder();
        int lastPost = formatted.lastIndexOf(HIGHLIGHT_POST);
        boolean inMatch = false;
        for (int i = 0; i < formatted.length(); i++) {
            char c = formatted.charAt(i);
            if (c == HIGHLIGHT_PRE && !inMatch && i < lastPost) {
                add(segments, current, false);
                inMatch = true;
            } else if (c == HIGHLIGHT_POST && inMatch) {
                add(segments, current, true);
                inMatch = false;
            } else if (!isPrivateUse(c)) {
                current.append(c);
            }
        }
        add(segments, current, inMatch);
        return segments;
    }

    /** Whether any segment matches. */
    public static boolean hasMatch(List<Segment> segments) {
        return segments != null && segments.stream().anyMatch(Segment::match);
    }

    public static String joined(List<Segment> segments) {
        StringBuilder text = new StringBuilder();
        segments.forEach(segment -> text.append(segment.text()));
        return text.toString();
    }

    private static void add(List<Segment> segments, StringBuilder text, boolean match) {
        if (text.isEmpty()) {
            return;
        }
        if (!segments.isEmpty() && segments.getLast().match() == match) {
            Segment last = segments.removeLast();
            segments.add(new Segment(last.text() + text, match));
        } else {
            segments.add(new Segment(text.toString(), match));
        }
        text.setLength(0);
    }

    private static boolean isPrivateUse(char c) {
        return c >= 0xE000 && c <= 0xF8FF;
    }
}
