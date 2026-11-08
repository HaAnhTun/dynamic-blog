package com.blog.siteimport.dto;

/** Something the parser skipped on purpose: {@code kind} is {@code section}, {@code subsection} or {@code field}. */
public record IgnoredItem(String kind, String sectionId, String name, int line) {}
