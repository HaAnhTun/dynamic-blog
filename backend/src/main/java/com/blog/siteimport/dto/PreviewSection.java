package com.blog.siteimport.dto;

import java.util.List;

/**
 * One section of the format in the preview. {@code status} is {@code new}, {@code will_change}, {@code unchanged},
 * {@code error} or {@code missing}; {@code line} is null when the section is not in the file.
 */
public record PreviewSection(
        String id,
        String heading,
        String key,
        Integer line,
        boolean present,
        String status,
        boolean selectable,
        List<PreviewChange> changes,
        List<String> missingOptional,
        List<ImportProblem> errors) {}
