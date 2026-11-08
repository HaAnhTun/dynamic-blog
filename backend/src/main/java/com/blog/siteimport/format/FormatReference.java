package com.blog.siteimport.format;

import com.blog.siteimport.format.PartSpec.Document;
import com.blog.siteimport.format.PartSpec.Fields;
import com.blog.siteimport.format.PartSpec.GroupBody;
import com.blog.siteimport.format.PartSpec.Groups;
import com.blog.siteimport.format.PartSpec.Paragraph;
import com.blog.siteimport.format.PartSpec.Rows;
import java.util.ArrayList;
import java.util.List;

/** The section reference of {@code docs/site-profile-format.md}, generated from the {@link SectionRegistry}. */
public final class FormatReference {

    private FormatReference() {}

    /** One subsection per section: heading, target key, description and a table of every value; ends with one newline. */
    public static String markdown() {
        List<String> blocks = new ArrayList<>();
        for (SectionDescriptor section : SectionRegistry.sections()) {
            blocks.add("### " + section.heading());
            blocks.add("Writes to the `" + section.key().key() + "` content. " + section.description());
            blocks.add(table(section));
        }
        return String.join("\n\n", blocks) + "\n";
    }

    private static String table(SectionDescriptor section) {
        List<String> lines = new ArrayList<>();
        lines.add("| Name | Required | Kind | Description |");
        lines.add("|---|---|---|---|");
        for (PartSpec part : section.parts()) {
            switch (part) {
                case Fields fields -> fields.fields().forEach(f -> lines.add(row(f, "field, a `- name: value` line")));
                case Paragraph paragraph -> lines.add(row(paragraph.field(), "paragraph below the heading"));
                case Document document ->
                    lines.add(row(document.field(), "Markdown document below the heading, read verbatim"));
                case Rows rows -> {
                    String where = rows.heading() == null ? "below the heading" : "under `## " + rows.heading() + "`";
                    if (rows.readOnly()) {
                        lines.add(note("Rows " + where, rows.description()));
                        break;
                    }
                    rows.columns()
                            .forEach(c ->
                                    lines.add(row(c, "row column " + position(rows.columns(), c) + ", " + where)));
                    lines.add(note("Rows " + where, rows.description()));
                }
                case Groups groups -> {
                    lines.add(row(groups.title(), "group title, the text of the `##` heading"));
                    if (groups.id() != null) {
                        lines.add(row(groups.id(), "group id, written as `{#id}`"));
                    }
                    groups.attributes().forEach(a -> lines.add(row(a, "group attribute in the braces")));
                    switch (groups.body()) {
                        case GroupBody.RowBody body ->
                            body.columns()
                                    .forEach(c -> lines.add(
                                            row(c, "row column " + position(body.columns(), c) + ", in a group")));
                        case GroupBody.FieldBody body -> body.fields().forEach(f -> lines.add(row(f, fieldKind(f))));
                        case GroupBody.ParagraphBody _ ->
                            lines.add("| paragraph | required | paragraph in a group, separated by blank lines | "
                                    + "The text of one paragraph. |");
                    }
                    lines.add(note("Groups", groups.description()));
                }
            }
        }
        return String.join("\n", lines);
    }

    private static String fieldKind(FieldSpec field) {
        return switch (field.shape()) {
            case SINGLE -> "entry field, a `- name: value` line";
            case LINES -> "entry field, a `- name: value` line that may repeat, one item each";
            case CELLS -> "entry field, one `- name: value` line with items separated by pipes";
        };
    }

    private static String row(FieldSpec field, String kind) {
        return "| `" + field.name() + "` | " + (field.required() ? "required" : "optional") + " | " + kind + " | "
                + cell(field.description()) + " |";
    }

    private static String note(String name, String description) {
        return "| " + name + " | | limit | " + cell(description) + " |";
    }

    private static int position(List<FieldSpec> columns, FieldSpec column) {
        return columns.indexOf(column) + 1;
    }

    private static String cell(String text) {
        return text.replace("|", "\\|");
    }
}
