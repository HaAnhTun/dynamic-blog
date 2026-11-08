package com.blog.postimport.dto;

/**
 * A blocking problem of a post file. Nothing in it comes from the file: {@code position} is the 1-based place of the file in the
 * upload, {@code key} a name of the format ({@code title}, {@code slug}...) or null, {@code line} a line number or null, and
 * {@code message} a fixed sentence that holds no value of the file and no title, slug or name of a post.
 */
public record PostImportProblem(int position, String key, Integer line, String message) {}
