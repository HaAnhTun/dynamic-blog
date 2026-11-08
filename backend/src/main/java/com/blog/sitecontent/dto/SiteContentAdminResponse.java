package com.blog.sitecontent.dto;

import java.util.List;
import java.util.Map;

/** The exact rows of one locale, with no fallback. */
public record SiteContentAdminResponse(
        String locale, String defaultLocale, List<String> locales, Map<String, SiteContentSectionState> sections) {}
