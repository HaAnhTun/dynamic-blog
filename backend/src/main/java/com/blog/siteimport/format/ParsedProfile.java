package com.blog.siteimport.format;

import java.util.List;
import java.util.Map;
import tools.jackson.databind.node.ObjectNode;

/**
 * What the parser makes of one file. It is purely syntactic: nothing here has been checked against the site content
 * validators, and nothing has been compared with what is stored. {@code problems} are blocking (a file with any problem
 * cannot be applied); {@code ignored} lists what the parser skipped on purpose.
 */
public record ParsedProfile(
        String schemaVersion,
        String contentType,
        String locale,
        List<ParsedSection> sections,
        List<Ignored> ignored,
        int ignoredTotal,
        List<Problem> problems) {

    /**
     * One section found in the file. {@code patch} holds only what the file gave: each present, non-empty field at its
     * pointer, and each present list (with at least one item) complete, its items already filled as the descriptor says.
     * {@code lines} maps every pointer of the patch (each leaf, each list item and each group) to the 1-based file line it
     * came from; {@code presentFields} are the field names given a non-empty value, for the "missing optional" report.
     */
    public record ParsedSection(
            SectionDescriptor descriptor,
            int line,
            ObjectNode patch,
            Map<String, Integer> lines,
            List<String> presentFields) {}

    /** A blocking problem. Every part but {@code message} may be null; {@code message} never contains a file value. */
    public record Problem(String sectionId, String field, Integer line, String message) {}

    /** Something skipped: {@code kind} is {@code section}, {@code subsection} or {@code field}; {@code name} is cut to 80 characters. */
    public record Ignored(String kind, String sectionId, String name, int line) {}
}
