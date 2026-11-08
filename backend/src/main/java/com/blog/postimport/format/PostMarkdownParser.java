package com.blog.postimport.format;

import com.blog.common.util.SlugGenerator;
import com.blog.media.entity.Media;
import com.blog.postimport.format.ParsedPost.Ignored;
import com.blog.postimport.format.ParsedPost.Problem;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Reads a decoded post file ({@link PostFile#decode}) into a {@link ParsedPost}. The input is untrusted: the parser is a
 * single pass over the lines with indexOf/charAt scanning (no regular expression over the file, no recursion), it never
 * interprets YAML or HTML (a value is the text after the first colon, nothing more), and its messages never contain a value
 * from the file (only key names of the format and numbers).
 *
 * <p>A file is a front matter block between two lines that contain only {@code ---}, then the Markdown body. The front
 * matter is {@code key: value} lines, with blank lines and {@code #} comment lines allowed. The body starts at the first
 * non-blank line after the closing fence and runs to the end of the file; it has no line cap.
 */
public final class PostMarkdownParser {

    /** Problem messages. None of them contains text from the file. */
    static final String NO_FRONT_MATTER = "the file must start with front matter between two --- lines";

    static final String NOT_CLOSED = "the front matter is not closed with ---";
    static final String NOT_KEY_VALUE = "front matter lines must be key: value";

    private static final String FENCE = "---";
    /** A file name longer than this is cut before it is turned into a slug: such a slug is refused anyway. */
    private static final int MAX_NAME_CHARS_READ = 1_000;

    private PostMarkdownParser() {}

    /**
     * Never throws for content problems: they go to {@link ParsedPost#problems()}.
     *
     * @param position 1-based position of the file in the upload
     * @param fileName the name the file was uploaded with (path allowed), the second source of the slug; may be null
     * @param text the output of {@link PostFile#decode}
     */
    public static ParsedPost parse(int position, String fileName, String text) {
        return new Run(position, fileName, text == null ? "" : text).parse();
    }

    private static boolean isFence(String line) {
        return line.strip().equals(FENCE);
    }

    /** 1 to 32 ASCII letters, digits, underscores or hyphens. */
    private static boolean isPlainWord(String key) {
        if (key.isEmpty() || key.length() > PostFileLimits.MAX_ECHOED_KEY_CHARS) {
            return false;
        }
        for (int i = 0; i < key.length(); i++) {
            char c = key.charAt(i);
            boolean plain =
                    (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
            if (!plain) {
                return false;
            }
        }
        return true;
    }

    /** The file name without its path and its {@code .md} extension. */
    private static String fileStem(String fileName) {
        if (fileName == null) {
            return "";
        }
        int slash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
        String name = fileName.substring(slash + 1);
        if (name.toLowerCase(Locale.ROOT).endsWith(".md")) {
            name = name.substring(0, name.length() - ".md".length());
        }
        return name.length() > MAX_NAME_CHARS_READ ? name.substring(0, MAX_NAME_CHARS_READ) : name;
    }

    /** One parse: the state of a single pass over the lines. */
    private static final class Run {

        private final int position;
        private final String fileName;
        private final String text;

        private final List<Problem> problems = new ArrayList<>();
        private final List<Ignored> ignored = new ArrayList<>();
        private final Map<PostKey, Integer> lines = new EnumMap<>(PostKey.class);
        private int problemsTotal;
        private int ignoredTotal;

        private String title;
        private String excerpt;
        private String category;
        private String language;
        private String slugKey;
        private boolean slugProblem;
        private String translationOf;
        private List<String> tags = List.of();
        private Boolean featured;
        private String status;
        private String series;
        private boolean seriesProblem;
        private Integer seriesPart;
        private String seriesDescription;
        private String cover;
        private String coverAlt;

        /** Offset of the next line to read, the number of the line read last and the offset where it started. */
        private int cursor;

        private int lineNumber;
        private int lineStart;

        Run(int position, String fileName, String text) {
            this.position = position;
            this.fileName = fileName;
            this.text = text;
        }

        ParsedPost parse() {
            String first = null;
            while (hasLine()) {
                String line = nextLine();
                if (!line.isBlank()) {
                    first = line;
                    break;
                }
            }
            if (first == null || !isFence(first)) {
                return failed(first == null ? 1 : lineNumber, NO_FRONT_MATTER);
            }
            int openLine = lineNumber;
            int inside = 0;
            boolean closed = false;
            while (hasLine()) {
                String line = nextLine();
                if (isFence(line)) {
                    closed = true;
                    break;
                }
                inside++;
                if (inside <= PostFileLimits.MAX_FRONT_MATTER_LINES) {
                    frontMatterLine(line, lineNumber);
                } else if (inside == PostFileLimits.MAX_FRONT_MATTER_LINES + 1) {
                    problem(
                            null,
                            lineNumber,
                            "the front matter has more than " + PostFileLimits.MAX_FRONT_MATTER_LINES + " lines");
                }
            }
            if (!closed) {
                // Nothing read between the fences can be trusted when the block never ends: say only that.
                return new Run(position, fileName, text).failed(openLine, NOT_CLOSED);
            }
            while (hasLine()) {
                String line = nextLine();
                if (!line.isBlank()) {
                    return finish(lineNumber, text.substring(lineStart), false);
                }
            }
            return finish(0, "", false);
        }

        /** The result for a file that cannot be read any further: one problem, no values. */
        private ParsedPost failed(int line, String message) {
            problem(null, line, message);
            return finish(0, "", true);
        }

        private boolean hasLine() {
            return cursor <= text.length();
        }

        private String nextLine() {
            int end = text.indexOf('\n', cursor);
            if (end < 0) {
                end = text.length();
            }
            lineStart = cursor;
            cursor = end + 1;
            lineNumber++;
            return text.substring(lineStart, end);
        }

        private void problem(PostKey key, Integer line, String message) {
            problemsTotal++;
            if (problems.size() < PostFileLimits.MAX_PROBLEMS) {
                problems.add(new Problem(position, key, line, message));
            }
        }

        // ---- front matter -------------------------------------------------------------------------------------

        private void frontMatterLine(String raw, int line) {
            int colon = raw.indexOf(':');
            if (raw.length() > PostFileLimits.MAX_FRONT_MATTER_LINE_CHARS
                    && raw.codePointCount(0, raw.length()) > PostFileLimits.MAX_FRONT_MATTER_LINE_CHARS) {
                PostKey named = colon < 0 ? null : PostKey.byName(PostNormalForm.strip(raw.substring(0, colon)));
                problem(
                        named,
                        line,
                        "the line is longer than " + PostFileLimits.MAX_FRONT_MATTER_LINE_CHARS + " characters");
                return;
            }
            if (raw.isBlank() || raw.stripLeading().startsWith("#")) {
                return;
            }
            if (colon < 0) {
                problem(null, line, NOT_KEY_VALUE);
                return;
            }
            String name = PostNormalForm.strip(raw.substring(0, colon));
            PostKey key = PostKey.byName(name);
            if (key == null) {
                ignore(name, line);
                return;
            }
            Integer first = lines.get(key);
            if (first != null) {
                problem(key, line, "the key " + key.keyName() + " is given twice; first at line " + first);
                return;
            }
            lines.put(key, line);
            value(key, PostNormalForm.strip(raw.substring(colon + 1)), line);
        }

        private void ignore(String name, int line) {
            ignoredTotal++;
            if (ignored.size() < PostFileLimits.MAX_IGNORED) {
                ignored.add(new Ignored(isPlainWord(name) ? name : null, line));
            }
        }

        private void value(PostKey key, String value, int line) {
            switch (key) {
                case TITLE -> title = limited(key, value, PostFileLimits.MAX_TITLE_CHARS, line);
                case EXCERPT -> excerpt = limited(key, value, PostFileLimits.MAX_EXCERPT_CHARS, line);
                case CATEGORY -> category = limited(key, value, PostFileLimits.MAX_CATEGORY_CHARS, line);
                case LANGUAGE -> language = limited(key, value, PostFileLimits.MAX_LANGUAGE_CHARS, line);
                case STATUS -> status = value.isEmpty() ? null : value;
                case SLUG -> {
                    slugKey = limited(key, value, PostFileLimits.MAX_SLUG_CHARS, line);
                    slugProblem = !value.isEmpty() && slugKey == null;
                }
                case TRANSLATION_OF -> translationOf(value, line);
                case TAGS -> tags(value, line);
                case FEATURED -> featured(value, line);
                case SERIES -> {
                    series = limited(key, value, PostFileLimits.MAX_SERIES_CHARS, line);
                    seriesProblem = !value.isEmpty() && series == null;
                }
                case SERIES_PART -> seriesPart(value, line);
                case SERIES_DESCRIPTION ->
                    seriesDescription = limited(key, value, PostFileLimits.MAX_SERIES_DESCRIPTION_CHARS, line);
                case COVER -> cover = limited(key, value, PostFileLimits.MAX_PACKAGE_NAME_CHARS, line);
                case COVER_ALT -> coverAlt = limited(key, value, Media.ALT_TEXT_MAX_LENGTH, line);
            }
        }

        /** The value, or null when it is empty or longer than {@code max} (a problem is recorded for the latter). */
        private String limited(PostKey key, String value, int max, int line) {
            if (value.isEmpty()) {
                return null;
            }
            if (value.length() > max) {
                problem(key, line, "the " + key.keyName() + " is longer than " + max + " characters");
                return null;
            }
            return value;
        }

        private void translationOf(String value, int line) {
            String raw = limited(PostKey.TRANSLATION_OF, value, PostFileLimits.MAX_SLUG_CHARS, line);
            if (raw == null) {
                return;
            }
            String slug = SlugGenerator.slugifyOrEmpty(raw);
            if (slug.isEmpty()) {
                problem(PostKey.TRANSLATION_OF, line, "translation_of is not a usable slug");
                return;
            }
            translationOf = slug;
        }

        private void tags(String value, int line) {
            List<String> names = new ArrayList<>();
            boolean tooLong = false;
            int start = 0;
            while (start <= value.length()) {
                int comma = value.indexOf(',', start);
                int end = comma < 0 ? value.length() : comma;
                String name = PostNormalForm.strip(value.substring(start, end));
                if (!name.isEmpty()) {
                    tooLong |= name.length() > PostFileLimits.MAX_TAG_CHARS;
                    names.add(name);
                }
                start = end + 1;
            }
            if (tooLong) {
                problem(PostKey.TAGS, line, "a tag is longer than " + PostFileLimits.MAX_TAG_CHARS + " characters");
            }
            if (names.size() > PostFileLimits.MAX_TAGS) {
                problem(PostKey.TAGS, line, "there are more than " + PostFileLimits.MAX_TAGS + " tags");
            }
            tags = tooLong || names.size() > PostFileLimits.MAX_TAGS ? List.of() : names;
        }

        private void featured(String value, int line) {
            if (value.isEmpty()) {
                return;
            }
            if (value.equalsIgnoreCase("true")) {
                featured = Boolean.TRUE;
            } else if (value.equalsIgnoreCase("false")) {
                featured = Boolean.FALSE;
            } else {
                problem(PostKey.FEATURED, line, "featured must be true or false");
            }
        }

        /** Digits 0 to 9 only (no sign, no other script), a value from 1 to the cap; anything else is a problem. */
        private void seriesPart(String value, int line) {
            if (value.isEmpty()) {
                return;
            }
            long part = 0;
            for (int i = 0; i < value.length(); i++) {
                char c = value.charAt(i);
                if (c < '0' || c > '9') {
                    part = -1;
                    break;
                }
                part = Math.min(part * 10 + (c - '0'), PostFileLimits.MAX_SERIES_PART + 1L);
            }
            if (part < 1 || part > PostFileLimits.MAX_SERIES_PART) {
                problem(
                        PostKey.SERIES_PART,
                        line,
                        "series_part is not a whole number from 1 to " + PostFileLimits.MAX_SERIES_PART);
                return;
            }
            seriesPart = (int) part;
        }

        // ---- result -------------------------------------------------------------------------------------------

        private ParsedPost finish(int bodyLine, String content, boolean unreadable) {
            String slug = null;
            SlugSource source = null;
            if (!slugProblem) {
                String fromKey = slugKey == null ? "" : SlugGenerator.slugifyOrEmpty(slugKey);
                String fromName = SlugGenerator.slugifyOrEmpty(fileStem(fileName));
                if (!fromKey.isEmpty()) {
                    slug = fromKey;
                    source = SlugSource.KEY;
                } else if (!fromName.isEmpty()) {
                    slug = fromName;
                    source = SlugSource.FILE_NAME;
                } else {
                    slug = SlugGenerator.slugify(title == null ? "" : title);
                    source = SlugSource.TITLE;
                }
                if (slug.length() > PostFileLimits.MAX_SLUG_CHARS) {
                    problem(
                            PostKey.SLUG,
                            lines.get(PostKey.SLUG),
                            "the slug is longer than " + PostFileLimits.MAX_SLUG_CHARS + " characters");
                    slug = null;
                    source = null;
                }
            }
            if (seriesPart != null && series == null && !seriesProblem) {
                problem(PostKey.SERIES_PART, lines.get(PostKey.SERIES_PART), "series_part needs series");
            }
            if (problemsTotal > PostFileLimits.MAX_PROBLEMS) {
                problems.set(
                        PostFileLimits.MAX_PROBLEMS - 1,
                        new Problem(
                                position,
                                null,
                                null,
                                "more problems were found; only the first " + (PostFileLimits.MAX_PROBLEMS - 1)
                                        + " are listed"));
            }
            PostFileValues values = new PostFileValues(
                    title,
                    slug,
                    language,
                    excerpt,
                    category,
                    tags,
                    featured,
                    status,
                    translationOf,
                    series,
                    seriesPart,
                    seriesDescription,
                    cover,
                    coverAlt,
                    content);
            return new ParsedPost(
                    position,
                    values,
                    source,
                    Collections.unmodifiableMap(new EnumMap<>(lines)),
                    bodyLine,
                    unreadable,
                    List.copyOf(ignored),
                    ignoredTotal,
                    List.copyOf(problems));
        }
    }
}
