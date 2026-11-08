package com.blog.series.dto;

/** A published part of a series in the public list: enough to build a link, with no extra call per series. */
public record SeriesPartRef(String slug, String title) {}
