package com.blog.sitecontent.dto;

import java.util.List;

/** What an import did to each section: {@code created}, {@code updated} or {@code unchanged}. */
public record SiteContentImportResponse(String locale, List<Section> sections) {

    public record Section(String key, String status) {}
}
