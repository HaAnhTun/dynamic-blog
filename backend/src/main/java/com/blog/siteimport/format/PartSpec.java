package com.blog.siteimport.format;

import java.util.List;

/**
 * A part of a section body. A section holds the parts in this order: first the parts that sit directly under the
 * {@code # Heading} ({@link Fields}, {@link Paragraph}, {@link Document}, or a {@link Rows} with a null heading), then the parts that
 * start with a {@code ## Heading} ({@link Rows} with a heading, or {@link Groups}).
 */
public sealed interface PartSpec {

    /** {@code - name: value} bullets; each present, non-empty value replaces that one field. */
    record Fields(List<FieldSpec> fields) implements PartSpec {}

    /** One free paragraph (soft-wrapped lines are joined with a space) that sets one field. */
    record Paragraph(FieldSpec field) implements PartSpec {}

    /**
     * One Markdown document, read verbatim: every line of the section up to the next level 1 heading that stands outside
     * a code fence (code fences, tables, lists, {@code ##} headings and article blocks are all text of the document).
     * It sets one field and is at most {@code maxLength} characters long.
     */
    record Document(FieldSpec field, int maxLength) implements PartSpec {}

    /**
     * {@code - cell | cell | cell} bullets, one list item each, columns by position. With a non-null {@code heading}
     * the rows sit under {@code ## heading}. When the part is present with at least one row it replaces the whole
     * list at {@code pointer}.
     *
     * <p>A {@code readOnly} part is an older way to write a list that another part of the section also writes: the
     * parser still reads it, the export and the template never write it, and a file that gives the list both ways is a
     * problem.
     */
    record Rows(String heading, String pointer, List<FieldSpec> columns, String description, boolean readOnly)
            implements PartSpec {

        public Rows(String heading, String pointer, List<FieldSpec> columns, String description) {
            this(heading, pointer, columns, description, false);
        }
    }

    /**
     * {@code ## Title {#id attr=value}} groups, each with a body of rows, paragraphs or field lines. When the part is
     * present with at least one group it replaces the whole list at {@code pointer}. {@code id} is null for a list whose
     * items have no identifier: the heading then has no {@code #id}.
     */
    record Groups(
            String pointer,
            FieldSpec title,
            FieldSpec id,
            List<FieldSpec> attributes,
            GroupBody body,
            String description)
            implements PartSpec {}

    /** The body of one group. */
    sealed interface GroupBody {

        /** Bullet rows; the list sits at {@code pointer} inside the group object. */
        record RowBody(String pointer, List<FieldSpec> columns) implements GroupBody {}

        /** Paragraphs separated by blank lines; the list of texts sits at {@code pointer} inside the group object. */
        record ParagraphBody(String pointer) implements GroupBody {}

        /**
         * {@code - name: value} bullets, one per field of the group object; a field of shape {@code LINES} or {@code CELLS}
         * holds a list of texts. An absent field is filled as its {@link Fill} says.
         */
        record FieldBody(List<FieldSpec> fields) implements GroupBody {}
    }
}
