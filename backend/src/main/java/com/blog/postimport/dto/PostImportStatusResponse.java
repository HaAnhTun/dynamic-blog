package com.blog.postimport.dto;

import java.time.Instant;

/** {@code lastImport} is the caller's own newest import, null when the caller never imported anything. */
public record PostImportStatusResponse(LastPostImport lastImport) {

    /**
     * @param files how many files the import applied
     * @param created how many new draft posts it made
     * @param updated how many existing posts it changed
     * @param undone whether it was undone
     * @param undoable whether it can be undone now without overwriting a later change
     */
    public record LastPostImport(
            long id, Instant createdAt, int files, int created, int updated, boolean undone, boolean undoable) {}
}
