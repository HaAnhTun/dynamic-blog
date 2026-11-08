package com.blog.common.text;

/**
 * The estimated reading time of a text, in whole minutes. One function for every place that shows or stores the figure, so the
 * number on a card, the number on the post and the total of a series cannot disagree.
 */
public final class ReadingTime {

    /** Words per minute. The conventional figure for prose; see the note on {@link #minutes}. */
    private static final int WORDS_PER_MINUTE = 200;

    private ReadingTime() {}

    /**
     * An estimated read time in whole minutes, never less than one.
     *
     * It counts tokens separated by any run of whitespace — spaces, tabs and line breaks alike — at 200 per minute. That is a
     * rough figure, not a calibrated one, and it is not biased in a known direction: Vietnamese writes each syllable as its own
     * token, which pushes the count above a word count, while code blocks are counted as prose although code is read more
     * slowly per token. An earlier version split on {@code "\s+"}, which in a Java string literal is a single space, so a
     * Markdown body whose words were separated only by line breaks was counted as a handful of tokens; the claim that the
     * estimate "errs long" did not hold then, and none is made now.
     *
     * Block marker lines and the source of a diagram block are not counted ({@link BlockMarkers}).
     */
    public static int minutes(String content) {
        if (content == null || content.isBlank()) {
            return 1;
        }
        String text = BlockMarkers.withoutMarkers(content).strip();
        if (text.isEmpty()) {
            return 1;
        }
        int words = text.split("\\s+").length;
        return Math.max(1, (int) Math.ceil((double) words / WORDS_PER_MINUTE));
    }
}
