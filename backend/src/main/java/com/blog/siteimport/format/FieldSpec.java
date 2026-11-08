package com.blog.siteimport.format;

/**
 * One named value of a section: a {@code - name: value} line, a free paragraph, a table column or a group attribute.
 * {@code pointer} is a JSON pointer inside the payload of the section's key (or inside the list item).
 */
public record FieldSpec(String name, String pointer, boolean required, Fill fill, String description, Shape shape) {

    /** How a field that sits in the lines of a group is written; every other field is {@link #SINGLE}. */
    public enum Shape {
        /** One value on one {@code - name: value} line. */
        SINGLE,
        /** A {@code - name: value} line that may repeat; each line adds one text to the list at the pointer. */
        LINES,
        /** One {@code - name: a | b | c} line whose pipe-separated cells are the texts of the list at the pointer. */
        CELLS
    }

    public FieldSpec(String name, String pointer, boolean required, Fill fill, String description) {
        this(name, pointer, required, fill, description, Shape.SINGLE);
    }
}
