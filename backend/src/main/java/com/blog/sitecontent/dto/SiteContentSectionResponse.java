package com.blog.sitecontent.dto;

import java.time.Instant;
import tools.jackson.databind.JsonNode;

/** One stored section as the admin sees it. */
public record SiteContentSectionResponse(
        String key, String locale, int schemaVersion, Instant updatedAt, JsonNode payload) {}
