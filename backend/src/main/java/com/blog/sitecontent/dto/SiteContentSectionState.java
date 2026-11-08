package com.blog.sitecontent.dto;

import java.time.Instant;
import tools.jackson.databind.JsonNode;

/** One stored section inside the admin list (the key is the map key). */
public record SiteContentSectionState(int schemaVersion, Instant updatedAt, JsonNode payload) {}
