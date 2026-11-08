package com.blog.postimport.format;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.List;
import java.util.Map;

/**
 * What the body of a package's article says about files, found by one pass over its lines, with no regular expression over the
 * text: the places where an image of the package is named, the unsafe content that is a problem, and the rewrite of the named
 * places once the images are stored. The body is untrusted; this class only reads it.
 *
 * <p>A <em>reference</em> is the destination of an inline Markdown image or link ({@code ![alt](dest)}, {@code [text](dest)}),
 * of a link reference definition ({@code [label]: dest}) and the {@code src} of a {@code figure} block. A {@code gallery} holds
 * ordinary Markdown images, so its images are references like any other. Fenced code and inline code are skipped: what a
 * tutorial shows in code is neither an image to store nor unsafe. Raw HTML such as {@code <img src>} is not a place that
 * names a package image; an image used only there counts as unused. A reference spans one line.
 *
 * <p>Nothing here holds a value out of the body in a message: a {@link Finding} is a fixed sentence and a line number.
 *
 * <p>The unsafe content is found line by line, with no Markdown or HTML parser: a best-effort lint that tells the author about
 * the usual mistakes, not a security boundary (a plain post file is not scanned at all). The barrier is the sanitizing schema of
 * the renderer, which cleans every post when it is rendered.
 */
public final class PostPackageRefs {

    /** Fixed sentences of the unsafe content. */
    static final String SCRIPT = "script elements are not allowed";

    static final String STYLE = "style elements are not allowed";
    static final String IFRAME = "iframe elements are not allowed";
    static final String OBJECT = "object elements are not allowed";
    static final String EMBED = "embed elements are not allowed";
    static final String JAVASCRIPT_URL = "javascript: URLs are not allowed";
    static final String EVENT_HANDLER = "inline event handler attributes (onclick and the like) are not allowed";

    private static final List<String> TAGS = List.of("<script", "<style", "<iframe", "<object", "<embed");
    private static final List<String> TAG_MESSAGES = List.of(SCRIPT, STYLE, IFRAME, OBJECT, EMBED);
    private static final int MAX_FIGURE_NAME = "figure".length();

    /** {@code &#x10FFFF;} has six digits and {@code &#1114111;} seven: a longer run is no character reference. */
    private static final int MAX_REFERENCE_DIGITS = 7;

    /**
     * A destination or a title longer than this is not read: no path to an image is that long, and a bound keeps a line that
     * holds thousands of unfinished links from costing a scan to its end for each one.
     */
    private static final int MAX_DESTINATION_CHARS = 2_000;

    private PostPackageRefs() {}

    /**
     * One place in the body that names a file.
     *
     * @param line 1-based line of the body
     * @param start offset in the body of the first character of {@code raw}
     * @param end offset after the last character of {@code raw}
     * @param raw the destination exactly as written
     * @param image whether it is an image (an inline image or a {@code figure}), so it must name an image of the package
     * @param alt the description of the image as written, null when there is none
     */
    public record Ref(int line, int start, int end, String raw, boolean image, String alt) {}

    /** Unsafe content: a fixed sentence and the 1-based line of the body. */
    public record Finding(int line, String message) {}

    public record Scan(List<Ref> refs, List<Finding> unsafe) {}

    public enum Kind {
        /** A URL, a site path or a fragment: nothing to look for in the package. */
        REMOTE,
        /** A path relative to the article file; {@code path} is normalized. */
        LOCAL,
        /** A relative path that leaves the package. */
        ESCAPES
    }

    public record Target(Kind kind, String path) {}

    // --- Scanning -------------------------------------------------------------------------------------------

    public static Scan scan(String body) {
        List<Ref> refs = new ArrayList<>();
        List<Finding> unsafe = new ArrayList<>();
        char fence = 0;
        int fenceLength = 0;
        boolean inTag = false;
        int line = 0;
        int offset = 0;
        while (offset <= body.length()) {
            int end = body.indexOf('\n', offset);
            if (end < 0) {
                end = body.length();
            }
            String text = body.substring(offset, end);
            line++;
            int indent = indentOf(text);
            char marker = indent < 4 ? fenceMarker(text, indent) : 0;
            if (fence != 0) {
                if (marker == fence && fenceRun(text, indent) >= fenceLength && onlyFence(text, indent, marker)) {
                    fence = 0;
                }
            } else if (marker != 0) {
                fence = marker;
                fenceLength = fenceRun(text, indent);
            } else {
                String masked = maskInlineCode(text);
                if (masked.isBlank()) {
                    inTag = false;
                }
                inTag = lineFindings(masked, line, inTag, unsafe);
                lineRefs(text, masked, offset, line, indent, refs);
            }
            offset = end + 1;
        }
        return new Scan(List.copyOf(refs), List.copyOf(unsafe));
    }

    private static int indentOf(String text) {
        int i = 0;
        while (i < text.length() && text.charAt(i) == ' ') {
            i++;
        }
        return i;
    }

    private static char fenceMarker(String text, int indent) {
        if (indent + 3 > text.length()) {
            return 0;
        }
        char c = text.charAt(indent);
        if ((c == '`' || c == '~') && fenceRun(text, indent) >= 3) {
            // The info string of a backtick fence holds no backtick: such a line is text, and what follows it is not
            // code.
            if (c == '`' && text.indexOf('`', indent + fenceRun(text, indent)) >= 0) {
                return 0;
            }
            return c;
        }
        return 0;
    }

    private static int fenceRun(String text, int indent) {
        char c = text.charAt(indent);
        int i = indent;
        while (i < text.length() && text.charAt(i) == c) {
            i++;
        }
        return i - indent;
    }

    private static boolean onlyFence(String text, int indent, char marker) {
        int i = indent + fenceRun(text, indent);
        return text.substring(i).isBlank();
    }

    /** The line with every inline code span replaced by spaces, so that offsets stay the same. */
    private static String maskInlineCode(String text) {
        if (text.indexOf('`') < 0) {
            return text;
        }
        char[] chars = text.toCharArray();
        int i = 0;
        while (i < chars.length) {
            char c = chars[i];
            if (c == '\\') {
                i += 2;
                continue;
            }
            if (c != '`') {
                i++;
                continue;
            }
            int run = 0;
            while (i + run < chars.length && chars[i + run] == '`') {
                run++;
            }
            int close = closingRun(chars, i + run, run);
            if (close < 0) {
                i += run;
                continue;
            }
            for (int k = i; k < close + run; k++) {
                chars[k] = ' ';
            }
            i = close + run;
        }
        return new String(chars);
    }

    private static int closingRun(char[] chars, int from, int run) {
        int i = from;
        while (i < chars.length) {
            if (chars[i] != '`') {
                i++;
                continue;
            }
            int length = 0;
            while (i + length < chars.length && chars[i + length] == '`') {
                length++;
            }
            if (length == run) {
                return i;
            }
            i += length;
        }
        return -1;
    }

    // --- Unsafe content -------------------------------------------------------------------------------------

    /** Adds what is unsafe in one line (outside code) and returns whether the line ends inside an HTML tag. */
    private static boolean lineFindings(String masked, int line, boolean inTagBefore, List<Finding> unsafe) {
        String lower = asciiLower(masked);
        for (int i = 0; i < TAGS.size(); i++) {
            int at = lower.indexOf(TAGS.get(i));
            if (at >= 0 && tagEnds(lower, at + TAGS.get(i).length())) {
                unsafe.add(new Finding(line, TAG_MESSAGES.get(i)));
            }
        }
        String decoded = asciiLower(decodeReferences(lower));
        if (decoded.contains("javascript:") || decoded.contains("vbscript:")) {
            unsafe.add(new Finding(line, JAVASCRIPT_URL));
        }
        boolean inTag = inTagBefore;
        boolean handler = false;
        for (int i = 0; i < lower.length(); i++) {
            char c = lower.charAt(i);
            if (!inTag) {
                inTag = c == '<' && i + 1 < lower.length() && Character.isLetter(lower.charAt(i + 1));
            } else if (c == '>') {
                inTag = false;
            } else if (!handler && c == 'o' && (i == 0 || separatesAttributes(lower.charAt(i - 1)))) {
                // At the start of a line this is only reached inside a tag that an earlier line opened.
                handler = isHandlerName(lower, i);
            }
        }
        if (handler) {
            unsafe.add(new Finding(line, EVENT_HANDLER));
        }
        return inTag;
    }

    /** {@code <scripts>} is not a script element: the name must end after the tag name. */
    private static boolean tagEnds(String lower, int at) {
        return at >= lower.length() || !Character.isLetterOrDigit(lower.charAt(at));
    }

    private static boolean separatesAttributes(char before) {
        return before == ' ' || before == '\t' || before == '"' || before == '\'' || before == '/';
    }

    /** {@code on} and at least one more letter, then optional spaces, then {@code =}. */
    private static boolean isHandlerName(String lower, int at) {
        if (at + 2 >= lower.length() || lower.charAt(at + 1) != 'n') {
            return false;
        }
        int i = at + 2;
        int letters = 0;
        while (i < lower.length() && lower.charAt(i) >= 'a' && lower.charAt(i) <= 'z') {
            i++;
            letters++;
        }
        while (i < lower.length() && (lower.charAt(i) == ' ' || lower.charAt(i) == '\t')) {
            i++;
        }
        return letters > 0 && i < lower.length() && lower.charAt(i) == '=';
    }

    /**
     * The line as a browser reads a URL in it: numeric character references ({@code &#106;}, {@code &#x6A;}) decoded and tabs
     * and line breaks dropped, so that {@code &#106;avascript:} and {@code java&#9;script:} are found. Named references are not
     * decoded. A reference is read within a few characters only, so the cost stays linear.
     */
    private static String decodeReferences(String lower) {
        if (lower.indexOf('&') < 0 && lower.indexOf('\t') < 0) {
            return lower;
        }
        StringBuilder out = new StringBuilder(lower.length());
        int i = 0;
        while (i < lower.length()) {
            char c = lower.charAt(i);
            int[] reference = c == '&' ? numericReference(lower, i) : null;
            if (reference == null) {
                appendUrlChar(out, c);
                i++;
            } else {
                appendUrlChar(out, reference[0]);
                i = reference[1];
            }
        }
        return out.toString();
    }

    private static void appendUrlChar(StringBuilder out, int codePoint) {
        if (codePoint != '\t' && codePoint != '\n' && codePoint != '\r') {
            out.appendCodePoint(codePoint);
        }
    }

    /** The numeric character reference that starts at {@code at}: {code point, index after the semicolon}, or null. */
    private static int[] numericReference(String text, int at) {
        if (at + 3 >= text.length() || text.charAt(at + 1) != '#') {
            return null;
        }
        boolean hex = text.charAt(at + 2) == 'x';
        int radix = hex ? 16 : 10;
        int i = hex ? at + 3 : at + 2;
        long code = 0;
        int digits = 0;
        while (i < text.length() && digits < MAX_REFERENCE_DIGITS && text.charAt(i) != ';') {
            int digit = Character.digit(text.charAt(i), radix);
            if (digit < 0) {
                return null;
            }
            code = code * radix + digit;
            digits++;
            i++;
        }
        if (digits == 0 || i >= text.length() || text.charAt(i) != ';' || !Character.isValidCodePoint((int) code)) {
            return null;
        }
        return new int[] {(int) code, i + 1};
    }

    private static String asciiLower(String text) {
        char[] chars = text.toCharArray();
        for (int i = 0; i < chars.length; i++) {
            if (chars[i] >= 'A' && chars[i] <= 'Z') {
                chars[i] = (char) (chars[i] + ('a' - 'A'));
            }
        }
        return new String(chars);
    }

    // --- References -----------------------------------------------------------------------------------------

    private record Open(boolean image, int labelStart) {}

    private static void lineRefs(String text, String masked, int offset, int line, int indent, List<Ref> refs) {
        if (indent < 4 && figureRefs(text, masked, offset, line, indent, refs)) {
            return;
        }
        if (indent < 4) {
            definition(text, masked, offset, line, indent, refs);
        }
        Deque<Open> open = new ArrayDeque<>();
        int i = 0;
        while (i < masked.length()) {
            char c = masked.charAt(i);
            if (c == '\\') {
                i += 2;
            } else if (c == '!' && i + 1 < masked.length() && masked.charAt(i + 1) == '[') {
                open.push(new Open(true, i + 2));
                i += 2;
            } else if (c == '[') {
                open.push(new Open(false, i + 1));
                i++;
            } else if (c == ']' && !open.isEmpty()) {
                Open label = open.pop();
                int after = i + 1;
                if (after < masked.length() && masked.charAt(after) == '(') {
                    int[] dest = destination(masked, after + 1);
                    if (dest != null) {
                        String alt = label.image() ? text.substring(label.labelStart(), i) : null;
                        addRef(refs, text, offset, line, dest[0], dest[1], label.image(), alt);
                        i = dest[2];
                        continue;
                    }
                }
                i++;
            } else {
                i++;
            }
        }
    }

    private static void addRef(
            List<Ref> refs, String text, int offset, int line, int start, int end, boolean image, String alt) {
        if (end > start) {
            refs.add(new Ref(line, offset + start, offset + end, text.substring(start, end), image, alt));
        }
    }

    /**
     * The destination that starts at {@code from} (just after the opening parenthesis): {start, end, index after the closing
     * parenthesis}, or null when this is not a destination followed by an optional title and a closing parenthesis.
     */
    private static int[] destination(String masked, int from) {
        int n = masked.length();
        int i = from;
        while (i < n && (masked.charAt(i) == ' ' || masked.charAt(i) == '\t')) {
            i++;
        }
        int start;
        int end;
        if (i < n && masked.charAt(i) == '<') {
            start = i + 1;
            end = start;
            while (end < n && end - start <= MAX_DESTINATION_CHARS && masked.charAt(end) != '>') {
                end++;
            }
            if (end >= n || masked.charAt(end) != '>') {
                return null;
            }
            i = end + 1;
        } else {
            start = i;
            int depth = 0;
            while (i < n) {
                if (i - start > MAX_DESTINATION_CHARS) {
                    return null;
                }
                char c = masked.charAt(i);
                if (c == '\\') {
                    i += 2;
                    continue;
                }
                if (c == ' ' || c == '\t') {
                    break;
                }
                if (c == '(') {
                    depth++;
                } else if (c == ')') {
                    if (depth == 0) {
                        break;
                    }
                    depth--;
                }
                i++;
            }
            end = Math.min(i, n);
        }
        while (i < n && (masked.charAt(i) == ' ' || masked.charAt(i) == '\t')) {
            i++;
        }
        if (i < n && (masked.charAt(i) == '"' || masked.charAt(i) == '\'')) {
            char quote = masked.charAt(i);
            int close = i + 1;
            while (close < n && close - i <= MAX_DESTINATION_CHARS && masked.charAt(close) != quote) {
                close++;
            }
            if (close >= n || masked.charAt(close) != quote) {
                return null;
            }
            i = close + 1;
            while (i < n && (masked.charAt(i) == ' ' || masked.charAt(i) == '\t')) {
                i++;
            }
        }
        if (i >= n || masked.charAt(i) != ')') {
            return null;
        }
        return new int[] {start, end, i + 1};
    }

    /** {@code [label]: destination "title"}. */
    private static void definition(String text, String masked, int offset, int line, int indent, List<Ref> refs) {
        int n = masked.length();
        if (indent >= n || masked.charAt(indent) != '[') {
            return;
        }
        int close = masked.indexOf(']', indent + 1);
        if (close < 0 || close + 1 >= n || masked.charAt(close + 1) != ':') {
            return;
        }
        int i = close + 2;
        while (i < n && (masked.charAt(i) == ' ' || masked.charAt(i) == '\t')) {
            i++;
        }
        int start;
        int end;
        if (i < n && masked.charAt(i) == '<') {
            start = i + 1;
            end = masked.indexOf('>', start);
            if (end < 0) {
                return;
            }
        } else {
            start = i;
            end = i;
            while (end < n && masked.charAt(end) != ' ' && masked.charAt(end) != '\t') {
                end++;
            }
        }
        addRef(refs, text, offset, line, start, end, false, null);
    }

    /**
     * A {@code figure} block: {@code :::figure{src="..." alt="..."}} or the leaf form {@code ::figure{...}}. Returns whether the
     * line is one, which ends the scan of the line (its attributes are not Markdown).
     */
    private static boolean figureRefs(String text, String masked, int offset, int line, int indent, List<Ref> refs) {
        int n = masked.length();
        int i = indent;
        while (i < n && masked.charAt(i) == ':') {
            i++;
        }
        if (i - indent < 2 || !masked.startsWith("figure", i)) {
            return false;
        }
        int afterName = i + MAX_FIGURE_NAME;
        if (afterName < n && masked.charAt(afterName) != '{' && masked.charAt(afterName) != ' ') {
            return false;
        }
        int brace = masked.indexOf('{', afterName);
        if (brace < 0) {
            return true;
        }
        int srcStart = -1;
        int srcEnd = -1;
        String alt = null;
        int p = brace + 1;
        while (p < n && masked.charAt(p) != '}') {
            char c = masked.charAt(p);
            if (c == ' ' || c == '\t') {
                p++;
                continue;
            }
            int nameStart = p;
            while (p < n && masked.charAt(p) != '=' && masked.charAt(p) != ' ' && masked.charAt(p) != '}') {
                p++;
            }
            String name = masked.substring(nameStart, p);
            if (p >= n || masked.charAt(p) != '=') {
                continue;
            }
            p++;
            int valueStart = p;
            int valueEnd;
            if (p < n && (masked.charAt(p) == '"' || masked.charAt(p) == '\'')) {
                char quote = masked.charAt(p);
                valueStart = p + 1;
                valueEnd = masked.indexOf(quote, valueStart);
                if (valueEnd < 0) {
                    return true;
                }
                p = valueEnd + 1;
            } else {
                while (p < n && masked.charAt(p) != ' ' && masked.charAt(p) != '}') {
                    p++;
                }
                valueEnd = p;
            }
            if (name.equals("src")) {
                srcStart = valueStart;
                srcEnd = valueEnd;
            } else if (name.equals("alt")) {
                alt = text.substring(valueStart, valueEnd);
            }
        }
        if (srcStart >= 0) {
            addRef(refs, text, offset, line, srcStart, srcEnd, true, alt);
        }
        return true;
    }

    // --- Resolving ------------------------------------------------------------------------------------------

    /** What a destination names: not a package file, a path in the package, or a path that leaves it. */
    public static Target resolve(String raw) {
        String s = raw.strip();
        if (s.isEmpty() || s.startsWith("/") || s.startsWith("#") || s.startsWith("?")) {
            return new Target(Kind.REMOTE, null);
        }
        int colon = s.indexOf(':');
        if (colon > 0 && schemeLike(s, colon)) {
            return new Target(Kind.REMOTE, null);
        }
        int cut = s.length();
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) == '#' || s.charAt(i) == '?') {
                cut = i;
                break;
            }
        }
        String path = Normalizer.normalize(percentDecode(s.substring(0, cut)), Normalizer.Form.NFC);
        List<String> parts = new ArrayList<>();
        for (String segment : path.split("/", -1)) {
            if (segment.isEmpty() || segment.equals(".")) {
                continue;
            }
            if (segment.equals("..")) {
                if (parts.isEmpty()) {
                    return new Target(Kind.ESCAPES, null);
                }
                parts.remove(parts.size() - 1);
            } else {
                parts.add(segment);
            }
        }
        return parts.isEmpty() ? new Target(Kind.REMOTE, null) : new Target(Kind.LOCAL, String.join("/", parts));
    }

    /** {@code https:}, {@code mailto:}, {@code data:}: a letter, then letters, digits, plus, dot or hyphen, before any slash. */
    private static boolean schemeLike(String s, int colon) {
        if (!Character.isLetter(s.charAt(0))) {
            return false;
        }
        for (int i = 0; i < colon; i++) {
            char c = s.charAt(i);
            if (!(Character.isLetterOrDigit(c) || c == '+' || c == '.' || c == '-')) {
                return false;
            }
        }
        return true;
    }

    private static String percentDecode(String s) {
        if (s.indexOf('%') < 0) {
            return s;
        }
        byte[] raw = s.getBytes(StandardCharsets.UTF_8);
        byte[] out = new byte[raw.length];
        int n = 0;
        for (int i = 0; i < raw.length; i++) {
            if (raw[i] == '%' && i + 2 < raw.length && hex(raw[i + 1]) >= 0 && hex(raw[i + 2]) >= 0) {
                out[n++] = (byte) (hex(raw[i + 1]) * 16 + hex(raw[i + 2]));
                i += 2;
            } else {
                out[n++] = raw[i];
            }
        }
        try {
            return StandardCharsets.UTF_8
                    .newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(out, 0, n))
                    .toString();
        } catch (CharacterCodingException e) {
            return s;
        }
    }

    private static int hex(byte b) {
        if (b >= '0' && b <= '9') {
            return b - '0';
        }
        if (b >= 'a' && b <= 'f') {
            return b - 'a' + 10;
        }
        if (b >= 'A' && b <= 'F') {
            return b - 'A' + 10;
        }
        return -1;
    }

    // --- Rewriting ------------------------------------------------------------------------------------------

    /** The body with each given place replaced; every other character is kept as it is. */
    public static String rewrite(String body, Map<Ref, String> replacements) {
        List<Map.Entry<Ref, String>> ordered = new ArrayList<>(replacements.entrySet());
        ordered.sort(
                Comparator.comparingInt((Map.Entry<Ref, String> e) -> e.getKey().start())
                        .reversed());
        StringBuilder out = new StringBuilder(body);
        for (Map.Entry<Ref, String> replacement : ordered) {
            out.replace(replacement.getKey().start(), replacement.getKey().end(), replacement.getValue());
        }
        return out.toString();
    }
}
