package com.blog.search.index;

import com.blog.common.text.BlockMarkers;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A post's Markdown turned into plain text for indexing and for cutting snippets: Markdown syntax and HTML tags are
 * removed, the text of code is kept as is. The goal is the text a reader sees when the post is rendered:
 * {@code json.loads}, {@code snake_case}, {@code C++}, {@code C#}, {@code Next.js} stay intact in code and in prose.
 *
 * Line by line, no tree is built: a code block (fence {@code ```} or {@code ~~~}) keeps each line and only the fence lines
 * are dropped; inline code keeps its text and loses the backticks; the rest loses line prefixes (headings, quotes,
 * bullets), links and images (keep the text, drop the URL), HTML tags, emphasis marks (only at word boundaries, so
 * {@code snake_case} keeps its underscore) and escapes.
 *
 * Block markers ({@code :::callout{...}}, {@code :::}) and the source of a {@code diagram} block are left out, the text of
 * the blocks is kept ({@link BlockMarkers}).
 *
 * Text the reader does NOT see is left out: the post page renders through rehype-raw then rehype-sanitize
 * ({@code lib/markdown.tsx}), where HTML comments are dropped and {@code <script>}, {@code <style>} are dropped together
 * with their content. Those three regions are dropped here, even when they span several lines; inside code blocks and
 * inline code they are plain text. A region that opens and never closes is dropped to the end of the post: better to
 * lose a passage from the index than to let hidden text show up in a snippet.
 *
 * The text is written by an author and a Java regular expression cannot be interrupted, so every pattern here must stay
 * cheap on hostile input: a loop over a group is possessive (a backtracking loop over a group recurses once per
 * iteration and overflows the stack on a long run), a run that could start at every position is bounded, and a line
 * longer than {@link #MAX_LINE_CHARS} is not read as Markdown at all.
 */
public final class MarkdownText {

    /**
     * The longest line that is read as Markdown. A longer line is kept as text the way it was written: whitespace is
     * collapsed and hidden regions are still dropped, but no syntax is stripped. Prose does not come close to this length;
     * a minified blob or a crafted line does, and the work of the patterns below is bounded by the length of one line.
     */
    static final int MAX_LINE_CHARS = 10_000;

    /**
     * Possessive, so that a line which fails at a line terminator inside it (a plain {@code .} stops at U+0085 or U+2028)
     * does not retry every shorter run of fence marks.
     */
    private static final Pattern FENCE = Pattern.compile("^ {0,3}(`{3,}+|~{3,}+).*+$");

    /**
     * A run of backticks that opens inline code is at most {@value #CODE_RUN_MAX} long: the opening run may give back
     * backticks until a closing run of the same length is found, and on a run of thousands of backticks that is quadratic.
     * No code span is written with that many.
     */
    private static final int CODE_RUN_MAX = 8;

    private static final Pattern INLINE_CODE = Pattern.compile("(`{1," + CODE_RUN_MAX + "})(.+?)\\1");
    private static final Pattern HEADING = Pattern.compile("^ {0,3}#{1,6}(?:\\s+|$)");

    /** Starts only at the beginning of a whitespace run, so a long run is scanned once and not once per position. */
    private static final Pattern HEADING_CLOSE = Pattern.compile("(?<!\\s)\\s++#++\\s*+$");

    private static final Pattern QUOTE = Pattern.compile("^ {0,3}(?:>\\s?+)++");
    private static final Pattern LIST_ITEM = Pattern.compile("^\\s*(?:[-*+]|\\d{1,9}[.)])\\s+(?:\\[[ xX]]\\s+)?");
    private static final Pattern RULE =
            Pattern.compile("^ {0,3}(?:(?:-\\s*+){3,}+|(?:\\*\\s*+){3,}+|(?:_\\s*+){3,}+)$");
    private static final Pattern TABLE_DIVIDER =
            Pattern.compile("^\\s*+\\|?+\\s*+:?+-{3,}+:?+\\s*+(?:\\|\\s*+:?+-{3,}+:?+\\s*+)*+\\|?+\\s*+$");
    private static final Pattern REFERENCE_DEFINITION = Pattern.compile("^ {0,3}\\[[^\\]]++]:\\s++\\S++.*+$");

    /** Link text and reference label are at most {@value #LABEL_MAX} characters, an autolink {@value #TARGET_MAX}. */
    private static final int LABEL_MAX = 300;

    private static final int TARGET_MAX = 1_000;
    private static final Pattern IMAGE_OR_LINK = Pattern.compile(
            "!?\\[([^\\]]{0," + LABEL_MAX + "}+)]\\((?:[^()\\s]++|\\([^()]*+\\))*+(?:\\s++\"[^\"]*+\")?+\\)");
    private static final Pattern REFERENCE_LINK =
            Pattern.compile("!?\\[([^\\]]{1," + LABEL_MAX + "}+)]\\[[^\\]]{0," + LABEL_MAX + "}+]");
    private static final Pattern AUTOLINK = Pattern.compile("<((?:https?|mailto):[^>\\s]{1," + TARGET_MAX + "}+)>");
    /**
     * Opens a region that is hidden when rendered: an HTML comment, or the opening tag {@code <script>}, {@code <style>}
     * (not {@code <styles>}).
     */
    private static final Pattern HIDDEN_OPEN =
            Pattern.compile("<!--|<(script|style)(?![A-Za-z0-9-])", Pattern.CASE_INSENSITIVE);

    private static final Pattern HTML_TAG = Pattern.compile("</?[A-Za-z][A-Za-z0-9-]*(?:\\s[^<>]*)?/?>");
    /**
     * Opening emphasis mark (not preceded by a letter, followed by one) and closing mark (the reverse); an underscore
     * between two letters stays. An escaped mark ({@code \*}) is not emphasis: {@link #ESCAPE} turns it back into text later.
     */
    private static final Pattern EMPHASIS_OPEN =
            Pattern.compile("(?<![\\p{L}\\p{N}*_~\\\\])(?:\\*{1,3}|_{1,3}|~~)(?=[^\\s*_~])");

    private static final Pattern EMPHASIS_CLOSE =
            Pattern.compile("(?<=[^\\s*_~\\\\])(?:\\*{1,3}|_{1,3}|~~)(?![\\p{L}\\p{N}*_~])");
    private static final Pattern ESCAPE = Pattern.compile("\\\\([!-/:-@\\[-`{-~])");
    private static final Pattern SPACES = Pattern.compile("[ \\t]+");

    private MarkdownText() {}

    /** Plain text of {@code markdown}; blocks are separated by one blank line, whitespace within a line is collapsed. null becomes empty. */
    public static String plain(String markdown) {
        if (markdown == null || markdown.isEmpty()) {
            return "";
        }
        List<String> out = new ArrayList<>();
        String fence = null;
        String hidden = null;
        for (String raw : BlockMarkers.withoutMarkers(markdown)
                .replace("\r\n", "\n")
                .replace('\r', '\n')
                .split("\n", -1)) {
            String line = raw;
            if (hidden != null) {
                // Inside a hidden region: drop everything up to whatever closes it; what follows the closer is plain
                // text.
                int end = closeOf(line, 0, hidden);
                if (end < 0) {
                    continue;
                }
                hidden = null;
                line = line.substring(end);
            }
            Matcher fenceLine = FENCE.matcher(line);
            if (fence == null && fenceLine.matches()) {
                fence = fenceLine.group(1);
                continue;
            }
            if (fence != null) {
                if (fenceLine.matches()
                        && fenceLine.group(1).charAt(0) == fence.charAt(0)
                        && fenceLine.group(1).length() >= fence.length()
                        && line.strip().equals(fenceLine.group(1))) {
                    fence = null;
                } else {
                    out.add(line.strip());
                }
                continue;
            }
            StringBuilder visible = new StringBuilder();
            boolean tooLong = line.length() > MAX_LINE_CHARS;
            hidden = hide(line, visible, tooLong);
            out.add(tooLong ? SPACES.matcher(visible).replaceAll(" ").strip() : prose(visible.toString()));
        }
        StringBuilder text = new StringBuilder();
        boolean blank = true;
        for (String line : out) {
            if (line.isEmpty()) {
                blank = true;
                continue;
            }
            if (!text.isEmpty()) {
                text.append(blank ? "\n\n" : "\n");
            }
            text.append(line);
            blank = false;
        }
        return text.toString();
    }

    /**
     * Copies the visible part of a line outside a code block into {@code visible}: hidden regions that close within the
     * line are dropped. A region that opens and does not close is dropped to the end of the line and its closer is
     * returned ({@code -->}, {@code </script}, {@code </style}), so following lines are dropped until it is found; null
     * when no region is left open. An opening mark inside inline code is text, except on a line over the cap
     * ({@code skipCode}): inline code is not looked for there, so a mark always opens a region, which loses a passage
     * rather than show hidden text.
     */
    private static String hide(String line, StringBuilder visible, boolean skipCode) {
        List<int[]> code = new ArrayList<>();
        Matcher span = INLINE_CODE.matcher(line);
        while (!skipCode && span.find()) {
            code.add(new int[] {span.start(), span.end()});
        }
        Matcher open = HIDDEN_OPEN.matcher(line);
        int cursor = 0;
        while (cursor < line.length() && open.find(cursor)) {
            int at = open.start();
            int[] literal = code.stream()
                    .filter(range -> range[0] <= at && at < range[1])
                    .findFirst()
                    .orElse(null);
            if (literal != null) {
                visible.append(line, cursor, literal[1]);
                cursor = literal[1];
                continue;
            }
            visible.append(line, cursor, at).append(' ');
            String closer = open.group(1) == null ? "-->" : "</" + open.group(1).toLowerCase(Locale.ROOT);
            int end = closeOf(line, open.end(), closer);
            if (end < 0) {
                return closer;
            }
            cursor = end;
        }
        visible.append(line, Math.min(cursor, line.length()), line.length());
        return null;
    }

    /**
     * Position right after the closer {@code closer} searched from {@code from}, case-insensitively; a closing tag extends
     * to its {@code >}. -1 when the line has none.
     */
    private static int closeOf(String line, int from, String closer) {
        for (int i = from; i + closer.length() <= line.length(); i++) {
            if (line.regionMatches(true, i, closer, 0, closer.length())) {
                if (closer.equals("-->")) {
                    return i + closer.length();
                }
                int gt = line.indexOf('>', i + closer.length());
                return gt < 0 ? -1 : gt + 1;
            }
        }
        return -1;
    }

    /** One line outside a code block: inline code is kept as is, syntax is removed from the rest. */
    private static String prose(String line) {
        if (RULE.matcher(line).matches()
                || TABLE_DIVIDER.matcher(line).matches()
                || REFERENCE_DEFINITION.matcher(line).matches()) {
            return "";
        }
        String body = line;
        Matcher heading = HEADING.matcher(body);
        if (heading.find()) {
            body = HEADING_CLOSE.matcher(body.substring(heading.end())).replaceFirst("");
        }
        body = QUOTE.matcher(body).replaceFirst("");
        body = LIST_ITEM.matcher(body).replaceFirst("");

        StringBuilder result = new StringBuilder();
        Matcher code = INLINE_CODE.matcher(body);
        int cursor = 0;
        while (code.find()) {
            result.append(markup(body.substring(cursor, code.start())));
            result.append(code.group(2).strip());
            cursor = code.end();
        }
        result.append(markup(body.substring(cursor)));
        String text = result.toString();
        if (text.indexOf('|') >= 0 && line.strip().startsWith("|")) {
            text = text.replace('|', ' ');
        }
        return SPACES.matcher(text).replaceAll(" ").strip();
    }

    /** Syntax inside a paragraph that is not code. */
    private static String markup(String text) {
        String out = AUTOLINK.matcher(text).replaceAll("$1");
        out = IMAGE_OR_LINK.matcher(out).replaceAll(match -> Matcher.quoteReplacement(match.group(1)));
        out = REFERENCE_LINK.matcher(out).replaceAll(match -> Matcher.quoteReplacement(match.group(1)));
        out = HTML_TAG.matcher(out).replaceAll(" ");
        out = EMPHASIS_OPEN.matcher(out).replaceAll("");
        out = EMPHASIS_CLOSE.matcher(out).replaceAll("");
        out = ESCAPE.matcher(out).replaceAll(match -> Matcher.quoteReplacement(match.group(1)));
        return out.replace("&nbsp;", " ")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&amp;", "&");
    }
}
