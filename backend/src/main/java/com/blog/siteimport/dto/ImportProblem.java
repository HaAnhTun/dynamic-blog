package com.blog.siteimport.dto;

/** A blocking problem of an import file. Every part but {@code message} may be null; the message never echoes a file value. */
public record ImportProblem(String sectionId, String field, Integer line, String message) {}
