package com.blog.common.text;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Takes the block syntax of an article out of its Markdown, for the figures computed from the text a reader sees (search
 * text, reading time). A post can hold blocks written as container directives ({@code :::callout{type="warning"}} ...
 * {@code :::}, {@code ::figure{...}}); the marker lines and their attributes are not prose, and a {@code diagram} body is
 * source code of a picture, not text. The text between the markers is kept.
 *
 * The check is line by line and does not validate: an unknown name is still a marker. Lines inside a code fence are
 * code and stay. A diagram keeps only its {@code title} and {@code alt} (its accessible name) and drops the source up to the
 * line that closes it with the same number of colons, or to the end of the document when it never closes. A document
 * without a marker line is returned as the same string, so figures of posts that do not use blocks cannot change.
 */
public final class BlockMarkers {

    /** Possessive, so a line that fails at a U+0085 or U+2028 inside it does not retry every shorter run of fence marks. */
    private static final Pattern FENCE = Pattern.compile("^ {0,3}(`{3,}+|~{3,}+).*+$");
    /** The line that closes a container: three or more colons and nothing else. */
    private static final Pattern CLOSER = Pattern.compile("^ {0,3}(:{3,})\\s*$");
    /** {@code :::name}, {@code :::name[label]{attributes}} or the leaf {@code ::name{attributes}}. */
    private static final Pattern OPENER =
            Pattern.compile("^ {0,3}(:{2,})([A-Za-z][A-Za-z0-9-]*)(?:\\[[^\\]]*])?(?:\\{.*})?\\s*$");

    private static final Pattern TEXT_ATTRIBUTE =
            Pattern.compile("\\b(?:title|alt)=(?:\"([^\"]*)\"|'([^']*)'|([^\\s}\"']+))");

    private BlockMarkers() {}

    /** {@code markdown} without block marker lines and diagram sources; null stays null. */
    public static String withoutMarkers(String markdown) {
        if (markdown == null || markdown.indexOf("::") < 0) {
            return markdown;
        }
        List<String> kept = new ArrayList<>();
        String fence = null;
        int diagramColons = 0;
        boolean changed = false;
        for (String line : markdown.split("\n", -1)) {
            String bare = line.endsWith("\r") ? line.substring(0, line.length() - 1) : line;
            if (diagramColons > 0) {
                Matcher closer = CLOSER.matcher(bare);
                if (closer.matches() && closer.group(1).length() == diagramColons) {
                    diagramColons = 0;
                }
                changed = true;
                continue;
            }
            Matcher fenceLine = FENCE.matcher(bare);
            if (fence != null) {
                if (fenceLine.matches()
                        && fenceLine.group(1).charAt(0) == fence.charAt(0)
                        && fenceLine.group(1).length() >= fence.length()
                        && bare.strip().equals(fenceLine.group(1))) {
                    fence = null;
                }
                kept.add(line);
                continue;
            }
            if (fenceLine.matches()) {
                fence = fenceLine.group(1);
                kept.add(line);
                continue;
            }
            Matcher opener = OPENER.matcher(bare);
            if (opener.matches()) {
                changed = true;
                if (opener.group(2).equals("diagram")) {
                    if (opener.group(1).length() >= 3) {
                        diagramColons = opener.group(1).length();
                    }
                    Matcher text = TEXT_ATTRIBUTE.matcher(bare);
                    while (text.find()) {
                        String value = text.group(1) != null
                                ? text.group(1)
                                : text.group(2) != null ? text.group(2) : text.group(3);
                        if (!value.isBlank()) {
                            kept.add(value);
                        }
                    }
                }
                continue;
            }
            if (CLOSER.matcher(bare).matches()) {
                changed = true;
                continue;
            }
            kept.add(line);
        }
        if (!changed) {
            return markdown;
        }
        String text = String.join("\n", kept);
        // An unclosed diagram drops the rest of the document, including the empty piece after the last line break.
        boolean lostFinalBreak = markdown.endsWith("\n") && !text.isEmpty() && !text.endsWith("\n");
        return lostFinalBreak ? text + "\n" : text;
    }
}
