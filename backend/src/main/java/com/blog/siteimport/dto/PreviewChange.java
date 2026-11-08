package com.blog.siteimport.dto;

/**
 * One difference between the stored content and the file. {@code kind} {@code value}: a field, with {@code before} and
 * {@code after} (cut to 200 characters); {@code kind} {@code list}: a list part, with the item counts.
 */
public record PreviewChange(
        String field, String kind, String before, String after, Integer added, Integer removed, Integer kept) {}
