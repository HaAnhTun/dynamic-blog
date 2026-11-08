package com.blog.siteimport.format;

import com.blog.siteimport.format.ParsedProfile.Ignored;
import com.blog.siteimport.format.ParsedProfile.ParsedSection;
import com.blog.siteimport.format.ParsedProfile.Problem;
import com.blog.siteimport.format.PartSpec.GroupBody;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * Reads a decoded profile file ({@link ProfileFile#decode}) into a {@link ParsedProfile}, following
 * {@code docs/site-profile-format.md}. The input is untrusted: the parser is a single pass over the lines with
 * indexOf/charAt scanning (no backtracking regular expression, no recursion over the input), it never interprets YAML or
 * HTML, and its messages never contain a value from the file (only field names known to the format and line numbers).
 */
public final class ProfileMarkdownParser {

    /** The one message for every YAML feature the front matter refuses. */
    public static final String YAML_MESSAGE = "anchors, aliases, tags and merge keys are not supported";

    public static final int MAX_IGNORED = 50;
    public static final int MAX_PROBLEMS = 100;
    /** Items read into one list (rows, groups, the rows or paragraphs of one group); the validators allow far fewer. */
    public static final int MAX_LIST_ITEMS = 100;

    /** A paragraph line that starts with a backslash and one of these is plain text without that backslash. */
    static final String PARAGRAPH_ESCAPABLE = "\\#-*+~`<_";

    static final int NAME_LIMIT = 80;
    static final int ID_LIMIT = 40;

    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;
    private static final char D_STROKE_LOWER = (char) 0x0111;
    private static final char D_STROKE_UPPER = (char) 0x0110;
    private static final String YAML_START_CHARS = "&*!|>[{%@`";
    private static final List<String> FRONT_MATTER_KEYS = List.of("schema_version", "content_type", "locale");

    private ProfileMarkdownParser() {}

    /** Input is the output of ProfileFile.decode. Never throws for content problems: they go to ParsedProfile.problems. */
    public static ParsedProfile parse(String text) {
        return new Run(text == null ? "" : text).parse();
    }

    /**
     * The name a list part goes by in {@code presentFields} and in reports: the {@code ## heading} of headed rows, else
     * the last segment of the list pointer ({@code entries}, {@code groups}, {@code sections}).
     */
    public static String listName(PartSpec part) {
        return switch (part) {
            case PartSpec.Rows rows -> rows.heading() != null ? rows.heading() : lastSegment(rows.pointer());
            case PartSpec.Groups groups -> lastSegment(groups.pointer());
            case PartSpec.Fields fields -> null;
            case PartSpec.Paragraph paragraph -> paragraph.field().name();
            case PartSpec.Document document -> document.field().name();
        };
    }

    /**
     * The id of a group derived from its title: accents removed (NFD, combining marks dropped, the Vietnamese d with stroke read as
     * {@code d}), lower case, every run of other characters turned into one hyphen, hyphens trimmed, at most 40
     * characters. Empty when nothing usable is left.
     */
    public static String deriveId(String title) {
        String decomposed = Normalizer.normalize(title, Normalizer.Form.NFD);
        StringBuilder out = new StringBuilder();
        boolean pendingDash = false;
        for (int i = 0; i < decomposed.length() && out.length() < ID_LIMIT; i++) {
            char c = decomposed.charAt(i);
            int type = Character.getType(c);
            if (type == Character.NON_SPACING_MARK
                    || type == Character.COMBINING_SPACING_MARK
                    || type == Character.ENCLOSING_MARK) {
                continue;
            }
            if (c == D_STROKE_LOWER || c == D_STROKE_UPPER) {
                c = 'd';
            } else if (c >= 'A' && c <= 'Z') {
                c = (char) (c + ('a' - 'A'));
            }
            if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) {
                if (pendingDash && !out.isEmpty()) {
                    out.append('-');
                }
                pendingDash = false;
                if (out.length() < ID_LIMIT) {
                    out.append(c);
                }
            } else {
                pendingDash = true;
            }
        }
        int end = out.length();
        while (end > 0 && out.charAt(end - 1) == '-') {
            end--;
        }
        return out.substring(0, end);
    }

    /** Removes the blank lines at the start and the end; the first and last text lines stay as written. */
    static String trimBlankLines(String text) {
        int start = 0;
        while (true) {
            int end = text.indexOf('\n', start);
            if (end < 0 || !text.substring(start, end).isBlank()) {
                break;
            }
            start = end + 1;
        }
        int stop = text.length();
        while (stop > start) {
            int begin = text.lastIndexOf('\n', stop - 1) + 1;
            if (begin <= start || !text.substring(begin, stop).isBlank()) {
                break;
            }
            stop = begin - 1;
        }
        String result = text.substring(start, stop);
        return result.isBlank() ? "" : result;
    }

    static boolean isValidId(String id) {
        if (id.isEmpty() || id.length() > ID_LIMIT) {
            return false;
        }
        for (int i = 0; i < id.length(); i++) {
            char c = id.charAt(i);
            if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) {
                return false;
            }
        }
        return true;
    }

    /** Splits a row on unescaped pipes and trims each cell; backslash-pipe is a pipe, double backslash a backslash. */
    static List<String> splitCells(String content) {
        List<String> cells = new ArrayList<>();
        StringBuilder cell = new StringBuilder();
        for (int i = 0; i < content.length(); i++) {
            char c = content.charAt(i);
            if (c == '\\' && i + 1 < content.length()) {
                char next = content.charAt(i + 1);
                if (next == '|' || next == '\\') {
                    cell.append(next);
                    i++;
                    continue;
                }
            }
            if (c == '|') {
                cells.add(cell.toString().strip());
                cell.setLength(0);
            } else {
                cell.append(c);
            }
        }
        cells.add(cell.toString().strip());
        return cells;
    }

    private static String lastSegment(String pointer) {
        return pointer.substring(pointer.lastIndexOf('/') + 1);
    }

    private static String cut(String text) {
        if (text.length() <= NAME_LIMIT) {
            return text;
        }
        int end = NAME_LIMIT;
        if (Character.isHighSurrogate(text.charAt(end - 1))) {
            end--;
        }
        return text.substring(0, end);
    }

    /** Lower case with every run of whitespace turned into one space, trimmed. */
    private static String normalizeHeading(String text) {
        StringBuilder out = new StringBuilder(text.length());
        boolean space = false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (Character.isWhitespace(c)) {
                space = !out.isEmpty();
            } else {
                if (space) {
                    out.append(' ');
                }
                space = false;
                out.append(c);
            }
        }
        return out.toString().toLowerCase(Locale.ROOT);
    }

    /** A field name as written: lower case, each run of spaces, tabs or hyphens read as one underscore. */
    private static String normalizeFieldName(String text) {
        String stripped = text.strip().toLowerCase(Locale.ROOT);
        StringBuilder out = new StringBuilder(stripped.length());
        boolean separator = false;
        for (int i = 0; i < stripped.length(); i++) {
            char c = stripped.charAt(i);
            if (c == ' ' || c == '\t' || c == '-') {
                separator = true;
            } else {
                if (separator) {
                    out.append('_');
                }
                separator = false;
                out.append(c);
            }
        }
        return out.toString();
    }

    private static int headingLevel(String stripped) {
        int level = 0;
        while (level < stripped.length() && stripped.charAt(level) == '#') {
            level++;
        }
        if (level == 0) {
            return 0;
        }
        if (level == stripped.length() || stripped.charAt(level) == ' ' || stripped.charAt(level) == '\t') {
            return level;
        }
        return 0;
    }

    private static boolean isFence(String stripped) {
        return stripped.startsWith("```") || stripped.startsWith("~~~");
    }

    private static boolean isThematicBreak(String stripped) {
        char mark = stripped.charAt(0);
        if (mark != '-' && mark != '*' && mark != '_') {
            return false;
        }
        int count = 0;
        for (int i = 0; i < stripped.length(); i++) {
            char c = stripped.charAt(i);
            if (c == mark) {
                count++;
            } else if (c != ' ' && c != '\t') {
                return false;
            }
        }
        return count >= 3;
    }

    private static boolean isBullet(String stripped) {
        return stripped.charAt(0) == '-'
                && (stripped.length() == 1 || stripped.charAt(1) == ' ' || stripped.charAt(1) == '\t');
    }

    /** Any list marker CommonMark knows: {@code -}, {@code *}, {@code +} or a number followed by {@code .} or {@code )}. */
    private static boolean isListItem(String stripped) {
        char first = stripped.charAt(0);
        if (first == '-' || first == '*' || first == '+') {
            return stripped.length() == 1 || stripped.charAt(1) == ' ' || stripped.charAt(1) == '\t';
        }
        int i = 0;
        while (i < stripped.length() && i < 10 && stripped.charAt(i) >= '0' && stripped.charAt(i) <= '9') {
            i++;
        }
        if (i == 0 || i >= stripped.length()) {
            return false;
        }
        char marker = stripped.charAt(i);
        if (marker != '.' && marker != ')') {
            return false;
        }
        return i + 1 == stripped.length() || stripped.charAt(i + 1) == ' ' || stripped.charAt(i + 1) == '\t';
    }

    private static boolean startsWithYaml(String value) {
        return !value.isEmpty() && YAML_START_CHARS.indexOf(value.charAt(0)) >= 0;
    }

    private static String unquote(String value) {
        if (value.length() >= 2) {
            char first = value.charAt(0);
            if ((first == '"' || first == '\'') && value.charAt(value.length() - 1) == first) {
                return value.substring(1, value.length() - 1);
            }
        }
        return value;
    }

    /** One parse: the state of a single pass over the lines. */
    private static final class Run {

        private final List<String> lines = new ArrayList<>();
        private final List<Problem> problems = new ArrayList<>();
        private final List<Ignored> ignored = new ArrayList<>();
        private final List<ParsedSection> sections = new ArrayList<>();
        private final Map<String, Integer> seenSections = new HashMap<>();
        private final String[] frontMatter = new String[FRONT_MATTER_KEYS.size()];
        private int ignoredTotal;
        private boolean problemsCut;

        private Section current;
        private boolean skippingSection;
        private boolean inComment;
        private int commentLine;

        Run(String text) {
            int start = 0;
            while (start <= text.length()) {
                int end = text.indexOf('\n', start);
                if (end < 0) {
                    end = text.length();
                }
                lines.add(text.substring(start, end));
                start = end + 1;
            }
        }

        ParsedProfile parse() {
            int body = parseFrontMatter();
            for (int index = body; index < lines.size(); index++) {
                bodyLine(lines.get(index), index + 1);
            }
            if (inComment) {
                problem(current == null ? null : current.id(), null, commentLine, "the comment is not closed with -->");
            }
            finishSection();
            return new ParsedProfile(
                    frontMatter[0],
                    frontMatter[1],
                    frontMatter[2],
                    List.copyOf(sections),
                    List.copyOf(ignored),
                    ignoredTotal,
                    List.copyOf(problems));
        }

        void problem(String sectionId, String field, Integer line, String message) {
            if (problems.size() < MAX_PROBLEMS) {
                problems.add(new Problem(sectionId, field, line, message));
            } else if (!problemsCut) {
                problemsCut = true;
                problems.add(new Problem(
                        null, null, null, "more problems were found; only the first " + MAX_PROBLEMS + " are listed"));
            }
        }

        void ignore(String kind, String sectionId, String name, int line) {
            ignoredTotal++;
            if (ignored.size() < MAX_IGNORED) {
                ignored.add(new Ignored(kind, sectionId, cut(name), line));
            }
        }

        // ---- front matter -------------------------------------------------------------------------------------

        /** Reads the front matter and returns the index of the first body line. */
        private int parseFrontMatter() {
            int open = 0;
            while (open < lines.size() && lines.get(open).isBlank()) {
                open++;
            }
            if (open >= lines.size() || !lines.get(open).strip().equals("---")) {
                problem(
                        null,
                        null,
                        Math.min(open, lines.size() - 1) + 1,
                        "the file must start with front matter between two --- lines");
                return open;
            }
            int close = open + 1;
            while (close < lines.size() && !lines.get(close).strip().equals("---")) {
                close++;
            }
            int end = close;
            int body = close + 1;
            if (close >= lines.size()) {
                problem(null, null, open + 1, "the front matter is not closed with ---");
                end = open + 1;
                while (end < lines.size() && headingLevel(lines.get(end).strip()) == 0) {
                    end++;
                }
                body = end;
            }
            int[] seenAt = new int[FRONT_MATTER_KEYS.size()];
            for (int index = open + 1; index < end; index++) {
                frontMatterLine(lines.get(index), index + 1, seenAt);
            }
            for (int key = 0; key < FRONT_MATTER_KEYS.size(); key++) {
                if (seenAt[key] == 0) {
                    String name = FRONT_MATTER_KEYS.get(key);
                    problem(null, name, open + 1, "the front matter key " + name + " is missing");
                }
            }
            return body;
        }

        private void frontMatterLine(String raw, int line, int[] seenAt) {
            if (raw.isBlank()) {
                return;
            }
            char first = raw.charAt(0);
            if (first == ' ' || first == '\t') {
                problem(null, null, line, YAML_MESSAGE);
                return;
            }
            int colon = raw.indexOf(':');
            if (colon < 0) {
                problem(null, null, line, startsWithYaml(raw) ? YAML_MESSAGE : "front matter lines must be key: value");
                return;
            }
            String key = raw.substring(0, colon).strip();
            if (key.startsWith("<<") || startsWithYaml(key)) {
                problem(null, null, line, YAML_MESSAGE);
                return;
            }
            int index = FRONT_MATTER_KEYS.indexOf(key);
            if (index < 0) {
                problem(null, null, line, "unknown front matter key");
                return;
            }
            if (seenAt[index] != 0) {
                problem(
                        null,
                        key,
                        line,
                        "the front matter key " + key + " is given twice; first at line " + seenAt[index]);
                return;
            }
            seenAt[index] = line;
            String value = raw.substring(colon + 1).strip();
            if (startsWithYaml(value)) {
                problem(null, key, line, YAML_MESSAGE);
                return;
            }
            frontMatter[index] = unquote(value);
        }

        // ---- body ---------------------------------------------------------------------------------------------

        private void bodyLine(String raw, int line) {
            if (inComment) {
                int end = raw.indexOf("-->");
                if (end >= 0) {
                    inComment = false;
                    afterComment(raw, end + 3, line);
                }
                return;
            }
            if (current != null && current.inFence()) {
                current.documentLine(raw, line);
                return;
            }
            String stripped = raw.strip();
            if (stripped.startsWith("<!--")) {
                if (current != null) {
                    current.flushParagraph();
                }
                int end = stripped.indexOf("-->", 4);
                if (end < 0) {
                    inComment = true;
                    commentLine = line;
                } else {
                    afterComment(stripped, end + 3, line);
                }
                return;
            }
            if (current != null && current.isDocument() && !startsLevelOneHeading(raw, stripped)) {
                current.documentLine(raw, line);
                return;
            }
            if (stripped.isEmpty()) {
                if (current != null) {
                    current.flushParagraph();
                }
                return;
            }
            boolean indented = raw.charAt(0) == ' ' || raw.charAt(0) == '\t';
            int level = headingLevel(stripped);
            if (level > 0 && !indented) {
                heading(level, stripped.substring(level).strip(), line);
                return;
            }
            if (skippingSection) {
                return;
            }
            if (current == null) {
                problem(null, null, line, "text before the first section heading is not allowed");
                return;
            }
            current.line(stripped, indented, level > 0, line);
        }

        /** A level 1 heading at the start of the line: the only line that ends a document section. */
        private static boolean startsLevelOneHeading(String raw, String stripped) {
            return !raw.isEmpty() && raw.charAt(0) == '#' && headingLevel(stripped) == 1;
        }

        private void afterComment(String text, int from, int line) {
            if (!skippingSection
                    && (current == null || !current.skippingSubsection())
                    && !text.substring(from).isBlank()) {
                problem(
                        current == null ? null : current.id(),
                        null,
                        line,
                        "text after --> on the same line is not read");
            }
        }

        private void heading(int level, String text, int line) {
            if (level == 1) {
                startSection(text, line);
                return;
            }
            if (skippingSection) {
                return;
            }
            if (current == null) {
                problem(null, null, line, "text before the first section heading is not allowed");
                return;
            }
            if (level == 2) {
                current.startSubsection(text, line);
                return;
            }
            if (current.skippingSubsection()) {
                return;
            }
            current.flushParagraph();
            problem(current.id(), null, line, "### and deeper headings are not supported");
        }

        private void startSection(String text, int line) {
            finishSection();
            skippingSection = false;
            Optional<SectionDescriptor> found = SectionRegistry.byHeading(text);
            if (found.isEmpty()) {
                ignore("section", null, text, line);
                skippingSection = true;
                return;
            }
            SectionDescriptor descriptor = found.get();
            Integer first = seenSections.get(descriptor.id());
            if (first != null) {
                problem(descriptor.id(), null, line, "the section appears twice; first at line " + first);
                skippingSection = true;
                return;
            }
            seenSections.put(descriptor.id(), line);
            current = new Section(this, descriptor, line);
        }

        private void finishSection() {
            if (current != null) {
                sections.add(current.finish());
                current = null;
            }
        }
    }

    private enum Mode {
        TOP,
        ROWS,
        GROUP,
        SKIP
    }

    /** The section being read: its parts, what the file gave so far, and where in the section the reader is. */
    private static final class Section {

        private final Run run;
        private final SectionDescriptor descriptor;
        private final int line;
        private final ObjectNode patch = JSON.objectNode();
        private final Map<String, Integer> lines = new LinkedHashMap<>();
        private final Set<String> present = new LinkedHashSet<>();

        private PartSpec.Fields fields;
        private PartSpec.Paragraph paragraph;
        private PartSpec.Rows topRows;
        private final List<PartSpec.Rows> headedRows = new ArrayList<>();
        private PartSpec.Groups groups;
        private PartSpec.Document document;

        private final List<String> documentLines = new ArrayList<>();
        private int documentFirstLine;
        private char fenceMark;
        private int fenceLength;

        private final Map<String, Integer> seenFields = new HashMap<>();
        private final Map<PartSpec.Rows, ArrayNode> rowItems = new LinkedHashMap<>();
        private final Map<PartSpec.Rows, Integer> rowLines = new HashMap<>();
        private final Map<String, Integer> groupIds = new HashMap<>();
        private final Set<ArrayNode> fullLists = Collections.newSetFromMap(new IdentityHashMap<>());
        private ArrayNode groupItems;
        private int groupsLine;

        private Mode mode = Mode.TOP;
        private PartSpec.Rows currentRows;
        private String currentGroupPointer;
        private ArrayNode currentBody;
        private ObjectNode currentGroup;
        private final Map<String, Integer> groupFieldLines = new HashMap<>();
        private int topParagraphs;

        private final StringBuilder paragraphText = new StringBuilder();
        private int paragraphLine;

        Section(Run run, SectionDescriptor descriptor, int line) {
            this.run = run;
            this.descriptor = descriptor;
            this.line = line;
            lines.put("", line);
            for (PartSpec part : descriptor.parts()) {
                switch (part) {
                    case PartSpec.Fields f -> fields = f;
                    case PartSpec.Paragraph p -> paragraph = p;
                    case PartSpec.Rows r -> {
                        if (r.heading() == null) {
                            topRows = r;
                        } else {
                            headedRows.add(r);
                        }
                    }
                    case PartSpec.Groups g -> groups = g;
                    case PartSpec.Document d -> document = d;
                }
            }
        }

        boolean isDocument() {
            return document != null;
        }

        boolean inFence() {
            return document != null && fenceMark != 0;
        }

        /** Keeps one line of a document section as written, and follows the code fences so that one hides its lines. */
        void documentLine(String raw, int at) {
            if (documentLines.isEmpty() && raw.isBlank()) {
                return;
            }
            if (documentLines.isEmpty()) {
                documentFirstLine = at;
            }
            documentLines.add(raw);
            String stripped = raw.strip();
            if (fenceMark != 0) {
                if (closesFence(stripped)) {
                    fenceMark = 0;
                }
                return;
            }
            int run = fenceRun(stripped);
            if (run >= 3) {
                fenceMark = stripped.charAt(0);
                fenceLength = run;
            }
        }

        private boolean closesFence(String stripped) {
            int run = fenceRun(stripped);
            return run >= fenceLength && stripped.charAt(0) == fenceMark && run == stripped.length();
        }

        /** The number of backticks or tildes the line starts with; 0 for a backtick fence whose info text has a backtick. */
        private static int fenceRun(String stripped) {
            if (stripped.isEmpty() || (stripped.charAt(0) != '`' && stripped.charAt(0) != '~')) {
                return 0;
            }
            char mark = stripped.charAt(0);
            int run = 0;
            while (run < stripped.length() && stripped.charAt(run) == mark) {
                run++;
            }
            return mark == '`' && stripped.indexOf('`', run) >= 0 ? 0 : run;
        }

        String id() {
            return descriptor.id();
        }

        boolean skippingSubsection() {
            return mode == Mode.SKIP;
        }

        private void problem(String field, int at, String message) {
            run.problem(descriptor.id(), field, at, message);
        }

        /** A non-blank body line that is not a comment and not a level 1 or 2 heading at the start of the line. */
        void line(String stripped, boolean indented, boolean heading, int at) {
            if (mode == Mode.SKIP) {
                return;
            }
            if (heading) {
                flushParagraph();
                problem(null, at, "a heading must start at the beginning of the line");
                return;
            }
            if (isFence(stripped)) {
                flushParagraph();
                problem(null, at, "code fences are not supported");
                return;
            }
            if (isThematicBreak(stripped)) {
                flushParagraph();
                problem(null, at, "a line of only ---, *** or ___ is not allowed");
                return;
            }
            if (indented && isListItem(stripped)) {
                flushParagraph();
                problem(null, at, "nested (indented) list items are not supported");
                return;
            }
            if (isBullet(stripped)) {
                flushParagraph();
                bullet(stripped.substring(1).strip(), at);
            } else {
                text(stripped, at);
            }
        }

        private void bullet(String content, int at) {
            switch (mode) {
                case TOP -> {
                    if (fields != null) {
                        field(content, at);
                    } else if (topRows != null) {
                        row(topRows, content, at);
                    } else if (paragraph != null) {
                        problem(paragraph.field().name(), at, "list items are not allowed here; write a paragraph");
                    } else {
                        problem(null, at, "start a ## group before this line");
                    }
                }
                case ROWS -> row(currentRows, content, at);
                case GROUP -> {
                    switch (groups.body()) {
                        case GroupBody.RowBody body -> groupRow(body, content, at);
                        case GroupBody.ParagraphBody body ->
                            problem("paragraph", at, "list items are not allowed here; write paragraphs");
                        case GroupBody.FieldBody body -> groupField(body, content, at);
                    }
                }
                case SKIP -> {}
            }
        }

        private void text(String stripped, int at) {
            switch (mode) {
                case TOP -> {
                    if (paragraph != null) {
                        appendParagraph(stripped, at);
                    } else if (fields != null || topRows != null) {
                        problem(null, at, "only - bullet lines are allowed here");
                    } else {
                        problem(null, at, "start a ## group before this line");
                    }
                }
                case ROWS -> problem(listName(currentRows), at, "only - bullet lines are allowed here");
                case GROUP -> {
                    if (groups.body() instanceof GroupBody.ParagraphBody) {
                        appendParagraph(stripped, at);
                    } else {
                        problem(null, at, "only - bullet lines are allowed here");
                    }
                }
                case SKIP -> {}
            }
        }

        private void appendParagraph(String stripped, int at) {
            if (paragraphText.isEmpty()) {
                paragraphLine = at;
            } else {
                paragraphText.append(' ');
            }
            boolean escaped = stripped.length() > 1
                    && stripped.charAt(0) == '\\'
                    && PARAGRAPH_ESCAPABLE.indexOf(stripped.charAt(1)) >= 0;
            paragraphText.append(stripped, escaped ? 1 : 0, stripped.length());
        }

        void flushParagraph() {
            if (paragraphText.isEmpty()) {
                return;
            }
            String value = paragraphText.toString();
            paragraphText.setLength(0);
            if (mode == Mode.TOP && paragraph != null) {
                FieldSpec field = paragraph.field();
                if (topParagraphs++ > 0) {
                    problem(field.name(), paragraphLine, "only one paragraph is allowed here");
                    return;
                }
                Pointers.set(patch, field.pointer(), JSON.stringNode(value));
                lines.put(field.pointer(), paragraphLine);
                present.add(field.name());
            } else if (mode == Mode.GROUP && currentBody != null) {
                String bodyPointer = ((GroupBody.ParagraphBody) groups.body()).pointer();
                if (!roomFor(currentBody, lastSegment(bodyPointer), paragraphLine)) {
                    return;
                }
                lines.put(currentGroupPointer + bodyPointer + "/" + currentBody.size(), paragraphLine);
                currentBody.add(value);
            }
        }

        private void field(String content, int at) {
            int colon = content.indexOf(':');
            if (colon < 0) {
                problem(null, at, "a field must be written - name: value");
                return;
            }
            String name = normalizeFieldName(content.substring(0, colon));
            FieldSpec spec = null;
            for (FieldSpec candidate : fields.fields()) {
                if (candidate.name().equals(name)) {
                    spec = candidate;
                }
            }
            if (spec == null) {
                run.ignore("field", descriptor.id(), name, at);
                return;
            }
            Integer first = seenFields.putIfAbsent(spec.name(), at);
            if (first != null) {
                problem(spec.name(), at, "the field " + spec.name() + " is given twice; first at line " + first);
                return;
            }
            String value = content.substring(colon + 1).strip();
            if (!value.isEmpty()) {
                Pointers.set(patch, spec.pointer(), JSON.stringNode(value));
                lines.put(spec.pointer(), at);
                present.add(spec.name());
            }
        }

        private void row(PartSpec.Rows rows, String content, int at) {
            ArrayNode items = rowItems.computeIfAbsent(rows, r -> JSON.arrayNode());
            rowLines.putIfAbsent(rows, at);
            if (roomFor(items, listName(rows), at)) {
                addRow(items, rows.pointer(), rows.columns(), listName(rows), content, at);
            }
        }

        /**
         * One {@code - name: value} line of an entry. An empty value counts as absent; a single value given twice in the same
         * entry is a problem; a line of {@code LINES} shape adds one text to its list and one of {@code CELLS} shape adds the
         * pipe-separated cells.
         */
        private void groupField(GroupBody.FieldBody body, String content, int at) {
            int colon = content.indexOf(':');
            if (colon < 0) {
                problem(null, at, "a field must be written - name: value");
                return;
            }
            String name = normalizeFieldName(content.substring(0, colon));
            FieldSpec spec = null;
            for (FieldSpec candidate : body.fields()) {
                if (candidate.name().equals(name)) {
                    spec = candidate;
                }
            }
            if (spec == null) {
                run.ignore("field", descriptor.id(), name, at);
                return;
            }
            String value = content.substring(colon + 1).strip();
            if (value.isEmpty()) {
                return;
            }
            String pointer = currentGroupPointer + spec.pointer();
            if (spec.shape() != FieldSpec.Shape.LINES) {
                Integer first = groupFieldLines.putIfAbsent(spec.name(), at);
                if (first != null) {
                    problem(
                            spec.name(),
                            at,
                            "the field " + spec.name() + " is given twice in this entry; first at line " + first);
                    return;
                }
            }
            switch (spec.shape()) {
                case SINGLE -> {
                    Pointers.set(currentGroup, spec.pointer(), JSON.stringNode(value));
                    lines.put(pointer, at);
                }
                case LINES -> {
                    ArrayNode items = listAt(spec.pointer());
                    if (roomFor(items, spec.name(), at)) {
                        lines.putIfAbsent(pointer, at);
                        lines.put(pointer + "/" + items.size(), at);
                        items.add(JSON.stringNode(value));
                    }
                }
                case CELLS -> {
                    ArrayNode items = listAt(spec.pointer());
                    for (String cell : splitCells(value)) {
                        if (!cell.isEmpty() && roomFor(items, spec.name(), at)) {
                            lines.putIfAbsent(pointer, at);
                            lines.put(pointer + "/" + items.size(), at);
                            items.add(JSON.stringNode(cell));
                        }
                    }
                    if (items.isEmpty()) {
                        currentGroup.remove(spec.pointer().substring(1));
                    }
                }
            }
        }

        /** The list of the current entry at a top-level pointer of the entry, created empty when it is not there yet. */
        private ArrayNode listAt(String pointer) {
            String property = pointer.substring(1);
            if (currentGroup.get(property) instanceof ArrayNode existing) {
                return existing;
            }
            return currentGroup.putArray(property);
        }

        private void groupRow(GroupBody.RowBody body, String content, int at) {
            if (roomFor(currentBody, lastSegment(body.pointer()), at)) {
                addRow(
                        currentBody,
                        currentGroupPointer + body.pointer(),
                        body.columns(),
                        listName(groups),
                        content,
                        at);
            }
        }

        /** Whether the list takes one more item; past the limit, reports it once and drops the rest of the list. */
        private boolean roomFor(ArrayNode items, String name, int at) {
            if (items.size() < MAX_LIST_ITEMS) {
                return true;
            }
            if (fullLists.add(items)) {
                problem(name, at, "the list " + name + " has more than " + MAX_LIST_ITEMS + " items");
            }
            return false;
        }

        private void addRow(
                ArrayNode items, String listPointer, List<FieldSpec> columns, String listName, String content, int at) {
            List<String> cells = splitCells(content);
            int count = cells.size();
            while (count > 0 && cells.get(count - 1).isEmpty()) {
                count--;
            }
            if (count > columns.size()) {
                problem(
                        listName,
                        at,
                        "this row has " + count + " cells but the list has only " + columns.size() + " columns");
                return;
            }
            String itemPointer = listPointer + "/" + items.size();
            ObjectNode item = JSON.objectNode();
            for (int i = 0; i < columns.size(); i++) {
                FieldSpec column = columns.get(i);
                if (put(item, column, i < count ? cells.get(i) : "")) {
                    lines.put(itemPointer + column.pointer(), at);
                }
            }
            items.add(item);
            lines.put(itemPointer, at);
        }

        /** Sets a list item value, or fills it as the descriptor says when empty; returns whether anything was set. */
        private static boolean put(ObjectNode item, FieldSpec spec, String value) {
            if (!value.isEmpty() || spec.required()) {
                Pointers.set(item, spec.pointer(), JSON.stringNode(value));
                return true;
            }
            switch (spec.fill()) {
                case NULL -> {
                    Pointers.set(item, spec.pointer(), JSON.nullNode());
                    return true;
                }
                case EMPTY -> {
                    Pointers.set(item, spec.pointer(), JSON.stringNode(""));
                    return true;
                }
                default -> {
                    return false;
                }
            }
        }

        void startSubsection(String text, int at) {
            flushParagraph();
            currentRows = null;
            currentBody = null;
            currentGroup = null;
            groupFieldLines.clear();
            currentGroupPointer = null;
            String wanted = normalizeHeading(text);
            for (PartSpec.Rows rows : headedRows) {
                if (normalizeHeading(rows.heading()).equals(wanted)) {
                    Integer first = rowLines.get(rows);
                    if (first != null) {
                        problem(
                                listName(rows),
                                at,
                                "the list " + rows.heading() + " appears twice; first at line " + first);
                        mode = Mode.SKIP;
                        return;
                    }
                    rowLines.put(rows, at);
                    rowItems.put(rows, JSON.arrayNode());
                    currentRows = rows;
                    mode = Mode.ROWS;
                    return;
                }
            }
            if (groups != null) {
                mode = startGroup(text, at) ? Mode.GROUP : Mode.SKIP;
                return;
            }
            run.ignore("subsection", descriptor.id(), text, at);
            mode = Mode.SKIP;
        }

        /** Starts a group; false when the list of groups is already full. */
        private boolean startGroup(String text, int at) {
            if (groupItems == null) {
                groupItems = JSON.arrayNode();
                groupsLine = at;
            }
            if (!roomFor(groupItems, listName(groups), at)) {
                return false;
            }
            String title = text;
            String block = null;
            if (text.endsWith("}")) {
                int open = text.lastIndexOf('{');
                if (open >= 0) {
                    block = text.substring(open + 1, text.length() - 1);
                    title = text.substring(0, open).strip();
                }
            } else if (unclosedBlock(text)) {
                problem(null, at, "the {...} block is not closed");
            }
            String groupPointer = groups.pointer() + "/" + groupItems.size();
            ObjectNode group = JSON.objectNode();
            Pointers.set(group, groups.title().pointer(), JSON.stringNode(title));
            lines.put(groupPointer + groups.title().pointer(), at);

            String explicitId = null;
            boolean idProblem = false;
            Map<String, String> attributes = new HashMap<>();
            for (String token : block == null ? List.<String>of() : tokens(block)) {
                if (token.charAt(0) == '#') {
                    if (groups.id() == null) {
                        problem(null, at, "the items of this list have no id; remove the #id from the braces");
                        continue;
                    }
                    if (explicitId != null || idProblem) {
                        problem(groups.id().name(), at, "the group id is given twice");
                        idProblem = true;
                        continue;
                    }
                    String id = token.substring(1);
                    if (!isValidId(id)) {
                        problem(
                                groups.id().name(),
                                at,
                                "the group id must be 1 to 40 lowercase letters, digits or hyphens");
                        idProblem = true;
                        continue;
                    }
                    explicitId = id;
                    continue;
                }
                int equals = token.indexOf('=');
                if (equals <= 0) {
                    problem(null, at, "group attributes must be written key=value");
                    continue;
                }
                String name = normalizeFieldName(token.substring(0, equals));
                FieldSpec attribute = null;
                for (FieldSpec candidate : groups.attributes()) {
                    if (candidate.name().equals(name)) {
                        attribute = candidate;
                    }
                }
                if (attribute == null) {
                    problem(null, at, "unknown group attribute");
                    continue;
                }
                if (attributes.putIfAbsent(attribute.name(), token.substring(equals + 1)) != null) {
                    problem(attribute.name(), at, "the attribute " + attribute.name() + " is given twice");
                }
            }

            String id = explicitId;
            if (id == null && !idProblem && groups.id() != null) {
                id = deriveId(title);
                if (id.isEmpty()) {
                    problem(groups.id().name(), at, "add {#id}: no id can be derived from this title");
                    id = null;
                }
            }
            if (id != null) {
                Integer first = groupIds.putIfAbsent(id, at);
                if (first != null) {
                    problem(groups.id().name(), at, "two groups have the same id; first at line " + first);
                }
                Pointers.set(group, groups.id().pointer(), JSON.stringNode(id));
                lines.put(groupPointer + groups.id().pointer(), at);
            }
            for (FieldSpec attribute : groups.attributes()) {
                if (put(group, attribute, attributes.getOrDefault(attribute.name(), ""))) {
                    lines.put(groupPointer + attribute.pointer(), at);
                }
            }
            ArrayNode body = null;
            switch (groups.body()) {
                case GroupBody.RowBody rows -> body = listOf(group, rows.pointer(), groupPointer, at);
                case GroupBody.ParagraphBody paragraphs -> body = listOf(group, paragraphs.pointer(), groupPointer, at);
                case GroupBody.FieldBody fieldBody -> {
                    for (FieldSpec field : fieldBody.fields()) {
                        if (field.shape() == FieldSpec.Shape.SINGLE && put(group, field, "")) {
                            lines.put(groupPointer + field.pointer(), at);
                        }
                    }
                }
            }
            groupItems.add(group);
            lines.put(groupPointer, at);
            currentGroupPointer = groupPointer;
            currentBody = body;
            currentGroup = group;
            return true;
        }

        /** The empty list of rows or paragraphs of a new group, at its pointer inside the group object. */
        private ArrayNode listOf(ObjectNode group, String pointer, String groupPointer, int at) {
            ArrayNode list = JSON.arrayNode();
            Pointers.set(group, pointer, list);
            lines.put(groupPointer + pointer, at);
            return list;
        }

        /** A heading not ending with a closing brace that still opens an id block, or a brace block with a key=value. */
        private static boolean unclosedBlock(String text) {
            if (text.contains("{#")) {
                return true;
            }
            int open = text.lastIndexOf(" {");
            return open >= 0 && tokens(text.substring(open + 2)).stream().anyMatch(token -> token.indexOf('=') > 0);
        }

        private static List<String> tokens(String block) {
            List<String> tokens = new ArrayList<>();
            int i = 0;
            while (i < block.length()) {
                while (i < block.length() && Character.isWhitespace(block.charAt(i))) {
                    i++;
                }
                int start = i;
                while (i < block.length() && !Character.isWhitespace(block.charAt(i))) {
                    i++;
                }
                if (i > start) {
                    tokens.add(block.substring(start, i));
                }
            }
            return tokens;
        }

        private void finishDocument() {
            String text = trimBlankLines(String.join("\n", documentLines));
            if (text.isEmpty()) {
                return;
            }
            FieldSpec field = document.field();
            if (text.codePointCount(0, text.length()) > document.maxLength()) {
                problem(
                        field.name(),
                        documentFirstLine,
                        "the " + field.name() + " is longer than " + document.maxLength() + " characters");
                return;
            }
            Pointers.set(patch, field.pointer(), JSON.stringNode(text));
            lines.put(field.pointer(), documentFirstLine);
            present.add(field.name());
        }

        ParsedSection finish() {
            flushParagraph();
            if (document != null) {
                finishDocument();
            }
            List<PartSpec.Rows> allRows = new ArrayList<>();
            if (topRows != null) {
                allRows.add(topRows);
            }
            allRows.addAll(headedRows);
            boolean groupsGiven = groupItems != null && !groupItems.isEmpty();
            boolean clash = false;
            for (PartSpec.Rows rows : allRows) {
                ArrayNode items = rowItems.get(rows);
                if (items != null && !items.isEmpty()) {
                    if (groupsGiven && groups.pointer().equals(rows.pointer())) {
                        // The same list written two ways: neither is read, whichever came last must not win silently.
                        clash = true;
                        problem(listName(groups), groupsLine, "give this list either as rows or as groups, not both");
                        continue;
                    }
                    Pointers.set(patch, rows.pointer(), items);
                    lines.put(rows.pointer(), rowLines.get(rows));
                    present.add(listName(rows));
                }
            }
            if (groupsGiven && !clash) {
                Pointers.set(patch, groups.pointer(), groupItems);
                lines.put(groups.pointer(), groupsLine);
                present.add(listName(groups));
            }
            return new ParsedSection(
                    descriptor,
                    line,
                    patch,
                    Collections.unmodifiableMap(new LinkedHashMap<>(lines)),
                    List.copyOf(present));
        }
    }
}
