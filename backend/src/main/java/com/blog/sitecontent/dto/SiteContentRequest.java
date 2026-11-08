package com.blog.sitecontent.dto;

import jakarta.validation.constraints.NotNull;
import tools.jackson.databind.JsonNode;

/** A section body: the schema version it is written in and the payload. Also one section of an export document. */
public record SiteContentRequest(
        @NotNull(message = "schemaVersion is required") Integer schemaVersion,
        @NotNull(message = "payload is required") JsonNode payload) {}
