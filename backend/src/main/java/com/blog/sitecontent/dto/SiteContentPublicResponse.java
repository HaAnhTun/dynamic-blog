package com.blog.sitecontent.dto;

import java.util.List;
import java.util.Map;
import tools.jackson.databind.JsonNode;

/** The public answer: only payloads, no id, timestamp or user. A key with no row is absent. */
public record SiteContentPublicResponse(
        String locale, String defaultLocale, List<String> locales, Map<String, JsonNode> sections) {}
