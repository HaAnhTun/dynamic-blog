package com.blog.sitecontent.dto;

import java.util.Map;

/** The export and import file: one locale, any subset of the nine keys. */
public record SiteContentDocument(
        String format, Integer formatVersion, String locale, Map<String, SiteContentRequest> sections) {

    public static final String FORMAT = "site-content";
    public static final int FORMAT_VERSION = 1;
}
