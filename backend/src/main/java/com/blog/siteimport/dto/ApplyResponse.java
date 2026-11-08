package com.blog.siteimport.dto;

import java.util.List;

/** The outcome of an import; {@code importId} is null when nothing was written. */
public record ApplyResponse(Long importId, String locale, String mode, List<AppliedSection> sections) {}
