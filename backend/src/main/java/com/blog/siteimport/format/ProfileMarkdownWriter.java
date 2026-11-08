package com.blog.siteimport.format;

import com.blog.sitecontent.schema.SiteContentKey;
import com.blog.siteimport.format.PartSpec.Document;
import com.blog.siteimport.format.PartSpec.Fields;
import com.blog.siteimport.format.PartSpec.GroupBody;
import com.blog.siteimport.format.PartSpec.Groups;
import com.blog.siteimport.format.PartSpec.Paragraph;
import com.blog.siteimport.format.PartSpec.Rows;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import tools.jackson.databind.JsonNode;

/**
 * Renders stored payloads as a site profile file. It reads the same {@link SectionRegistry} as the parser, so what it
 * writes is what the parser reads back: the export and the downloadable template are both made here.
 */
public final class ProfileMarkdownWriter {

    private static final String COMMENT_START = "<!--";
    private static final String COMMENT_END = "-->";

    private ProfileMarkdownWriter() {}

    /**
     * Writes the front matter and, in registry order, every section whose key has a payload. Every field of the
     * descriptor gets a line even when its value is empty. With {@code annotated} each heading is followed by an HTML
     * comment that describes the section and its fields, and an empty list gets a commented example row.
     */
    public static String write(String locale, Map<SiteContentKey, JsonNode> payloads, boolean annotated) {
        String body = sections(payloads, annotated);
        return body.isEmpty() ? frontMatter(locale) : frontMatter(locale) + "\n" + body;
    }

    static String frontMatter(String locale) {
        return "---\nschema_version: " + SectionRegistry.SCHEMA_VERSION + "\ncontent_type: "
                + SectionRegistry.CONTENT_TYPE + "\nlocale: " + oneLine(locale) + "\n---\n";
    }

    /** The sections only, as paragraph-separated blocks, ending with one newline; empty when no key has a payload. */
    static String sections(Map<SiteContentKey, JsonNode> payloads, boolean annotated) {
        List<String> blocks = new ArrayList<>();
        for (SectionDescriptor section : SectionRegistry.sections()) {
            JsonNode payload = payloads.get(section.key());
            if (payload != null) {
                writeSection(section, payload, annotated, blocks);
            }
        }
        return blocks.isEmpty() ? "" : String.join("\n\n", blocks) + "\n";
    }

    /** An HTML comment block: the parser skips it, and the template reuses it for its instructions. */
    static String comment(List<String> lines) {
        return COMMENT_START + "\n" + String.join("\n", lines) + "\n" + COMMENT_END;
    }

    private static void writeSection(
            SectionDescriptor section, JsonNode payload, boolean annotated, List<String> blocks) {
        if (!annotated && isEmptyDocument(section, payload)) {
            return;
        }
        blocks.add("# " + section.heading());
        if (annotated) {
            blocks.add(comment(sectionNotes(section)));
        }
        for (PartSpec part : section.parts()) {
            switch (part) {
                case Fields fields ->
                    blocks.add(fields.fields().stream()
                            .map(f -> "- " + f.name() + ":" + valueSuffix(text(payload, f.pointer())))
                            .collect(Collectors.joining("\n")));
                case Paragraph paragraph -> {
                    String text = text(payload, paragraph.field().pointer());
                    if (!text.isEmpty()) {
                        blocks.add(escapeParagraph(text));
                    }
                }
                case Document document -> {
                    String body = documentText(payload, document.field().pointer());
                    if (!body.isEmpty()) {
                        blocks.add(body);
                    }
                }
                case Rows rows -> {
                    if (rows.readOnly()) {
                        break;
                    }
                    if (rows.heading() != null) {
                        blocks.add("## " + rows.heading());
                    }
                    List<String> lines = rowLines(payload.at(rows.pointer()), rows.columns());
                    if (!lines.isEmpty()) {
                        blocks.add(String.join("\n", lines));
                    } else if (annotated) {
                        blocks.add(comment(List.of(
                                "Example row (remove the comment markers to use it):",
                                "- " + String.join(" | ", exampleCells(rows.columns())))));
                    }
                }
                case Groups groups -> writeGroups(groups, payload, blocks);
            }
        }
    }

    /** A section that is one document the payload does not have: an export leaves it out instead of writing a bare heading. */
    private static boolean isEmptyDocument(SectionDescriptor section, JsonNode payload) {
        return section.parts().size() == 1
                && section.parts().getFirst() instanceof Document document
                && documentText(payload, document.field().pointer()).isEmpty();
    }

    private static void writeGroups(Groups groups, JsonNode payload, List<String> blocks) {
        for (JsonNode group : payload.at(groups.pointer())) {
            List<String> tokens = new ArrayList<>();
            if (groups.id() != null) {
                tokens.add("#" + oneLine(text(group, groups.id().pointer())));
            }
            for (FieldSpec attribute : groups.attributes()) {
                String value = text(group, attribute.pointer());
                if (!value.isEmpty()) {
                    tokens.add(attribute.name() + "=" + value);
                }
            }
            blocks.add("## " + oneLine(text(group, groups.title().pointer()))
                    + (tokens.isEmpty() ? "" : " {" + String.join(" ", tokens) + "}"));
            switch (groups.body()) {
                case GroupBody.FieldBody body -> blocks.add(String.join("\n", fieldLines(group, body.fields())));
                case GroupBody.RowBody body -> {
                    List<String> lines = rowLines(group.at(body.pointer()), body.columns());
                    if (!lines.isEmpty()) {
                        blocks.add(String.join("\n", lines));
                    }
                }
                case GroupBody.ParagraphBody body ->
                    group.at(body.pointer())
                            .forEach(paragraph -> blocks.add(escapeParagraph(oneLine(paragraph.asString("")))));
            }
        }
    }

    /**
     * One {@code - name: value} line for every field of an entry, empty when the entry has no value, so that each field can be
     * found and filled by hand. A list of lines gets one line per text (one empty line when there is none); a list of cells one
     * line with the texts joined by pipes.
     */
    private static List<String> fieldLines(JsonNode group, List<FieldSpec> fields) {
        List<String> lines = new ArrayList<>();
        for (FieldSpec field : fields) {
            switch (field.shape()) {
                case SINGLE -> lines.add("- " + field.name() + ":" + valueSuffix(text(group, field.pointer())));
                case CELLS -> {
                    List<String> cells = new ArrayList<>();
                    group.at(field.pointer()).forEach(item -> cells.add(escapeCell(oneLine(item.asString("")))));
                    lines.add("- " + field.name() + ":" + valueSuffix(String.join(" | ", cells)));
                }
                case LINES -> {
                    JsonNode items = group.at(field.pointer());
                    if (items.isEmpty()) {
                        lines.add("- " + field.name() + ":");
                    }
                    items.forEach(
                            item -> lines.add("- " + field.name() + ":" + valueSuffix(oneLine(item.asString("")))));
                }
            }
        }
        return lines;
    }

    private static List<String> rowLines(JsonNode list, List<FieldSpec> columns) {
        List<String> lines = new ArrayList<>();
        for (JsonNode item : list) {
            List<String> cells = new ArrayList<>();
            for (FieldSpec column : columns) {
                cells.add(escapeCell(text(item, column.pointer())));
            }
            int end = cells.size();
            while (end > 1 && cells.get(end - 1).isEmpty()) {
                end--;
            }
            lines.add("- " + String.join(" | ", cells.subList(0, end)));
        }
        return lines;
    }

    private static List<String> exampleCells(List<FieldSpec> columns) {
        List<String> cells = new ArrayList<>();
        for (FieldSpec column : columns) {
            if (column.required()) {
                boolean address = column.name().equals("url") || column.name().equals("link");
                cells.add(address ? "https://example.com/" : "Example " + column.name());
            }
        }
        return cells;
    }

    /** Escapes what a cell cannot carry: the separator, and a backslash only where it would be read as an escape. */
    static String escapeCell(String value) {
        StringBuilder out = new StringBuilder(value.length() + 4);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '|') {
                out.append("\\|");
            } else if (c == '\\' && i + 1 < value.length() && isEscapable(value.charAt(i + 1))) {
                out.append("\\\\");
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    private static boolean isEscapable(char next) {
        return next == '\\' || next == '|';
    }

    /** A paragraph that would start a heading, bullet, fence, comment or break (or starts with a backslash) gets one. */
    static String escapeParagraph(String text) {
        boolean escape = !text.isEmpty() && ProfileMarkdownParser.PARAGRAPH_ESCAPABLE.indexOf(text.charAt(0)) >= 0;
        return escape ? "\\" + text : text;
    }

    private static List<String> sectionNotes(SectionDescriptor section) {
        List<String> lines = new ArrayList<>();
        lines.add(section.description());
        for (PartSpec part : section.parts()) {
            switch (part) {
                case Fields fields -> fields.fields().forEach(f -> lines.add(note("- " + f.name(), f)));
                case Paragraph paragraph -> {
                    lines.add("Write one paragraph below the heading.");
                    lines.add(note(paragraph.field().name(), paragraph.field()));
                }
                case Document document -> {
                    lines.add("Write Markdown below the heading, with the same blocks as an article. A level 1 heading"
                            + " (a line starting with one #) ends the body, so use ## and deeper.");
                    lines.add(note(document.field().name(), document.field()));
                }
                case Rows rows -> {
                    String where = rows.heading() == null ? "below the heading" : "under ## " + rows.heading();
                    if (rows.readOnly()) {
                        lines.add("Rows " + where + " (" + columnNames(rows.columns()) + "): " + rows.description());
                        break;
                    }
                    lines.add("Rows " + where + ", one per line: - " + columnNames(rows.columns()) + ". "
                            + rows.description());
                    rows.columns().forEach(c -> lines.add(note("  column " + c.name(), c)));
                }
                case Groups groups -> {
                    lines.add("Groups, each starting with ## " + groups.title().name()
                            + (groups.id() == null ? " {...}. " : " {#id ...}. ") + groups.description());
                    lines.add(note("  title", groups.title()));
                    if (groups.id() != null) {
                        lines.add(note("  id", groups.id()));
                    }
                    groups.attributes().forEach(a -> lines.add(note("  attribute " + a.name(), a)));
                    switch (groups.body()) {
                        case GroupBody.RowBody body -> {
                            lines.add("  Each group holds rows, one per line: - " + columnNames(body.columns()));
                            body.columns().forEach(c -> lines.add(note("  column " + c.name(), c)));
                        }
                        case GroupBody.ParagraphBody body ->
                            lines.add("  Each group holds paragraphs separated by blank lines.");
                        case GroupBody.FieldBody body -> {
                            lines.add("  Each group holds one line per detail: - name: value");
                            body.fields().forEach(f -> lines.add(note("  - " + f.name(), f)));
                        }
                    }
                }
            }
        }
        return lines;
    }

    private static String columnNames(List<FieldSpec> columns) {
        return columns.stream().map(FieldSpec::name).collect(Collectors.joining(" | "));
    }

    private static String note(String label, FieldSpec field) {
        return label + " (" + (field.required() ? "required" : "optional") + "): " + field.description();
    }

    private static String text(JsonNode node, String pointer) {
        JsonNode value = node.at(pointer);
        return value.isValueNode() && !value.isNull() ? oneLine(value.asString()) : "";
    }

    /** A stored document as the file carries it: line breaks unified, NFC, no blank line at either end. */
    private static String documentText(JsonNode node, String pointer) {
        JsonNode value = node.at(pointer);
        if (!value.isString()) {
            return "";
        }
        String lf = value.asString().replace("\r\n", "\n").replace('\r', '\n');
        return ProfileMarkdownParser.trimBlankLines(Normalizer.normalize(lf, Normalizer.Form.NFC));
    }

    private static String valueSuffix(String value) {
        return value.isEmpty() ? "" : " " + value;
    }

    /**
     * A file value lives on one line (a stray line break must not break the structure) and in NFC, like the parser reads
     * it back after decoding.
     */
    private static String oneLine(String value) {
        String flat = value.replace("\r\n", " ").replace('\n', ' ').replace('\r', ' ');
        return Normalizer.normalize(flat, Normalizer.Form.NFC);
    }
}
