package com.blog.search.dto;

/**
 * One segment of a title or description in a search result: the verbatim text, and whether it matches the query. The
 * segments of a field concatenate back to the original string. No HTML goes over the wire: the frontend renders {@code <mark>}.
 */
public record Segment(String text, boolean match) {}
