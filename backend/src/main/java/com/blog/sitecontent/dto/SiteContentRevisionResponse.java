package com.blog.sitecontent.dto;

import java.time.Instant;

/** A revision in the list: no data. */
public record SiteContentRevisionResponse(long id, int schemaVersion, Instant createdAt) {}
