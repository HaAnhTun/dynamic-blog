package com.blog.siteimport.dto;

import java.time.Instant;
import java.util.List;

/** The newest import; {@code undoable} when it can still be undone without overwriting a later change. */
public record LastImport(
        long id,
        Instant createdAt,
        String locale,
        String mode,
        boolean undone,
        boolean undoable,
        List<LoggedSection> sections) {}
