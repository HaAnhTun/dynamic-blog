package com.blog.siteimport.dto;

import com.blog.postimport.dto.PostImportNote;
import com.blog.postimport.dto.PostPackageFacts;
import java.util.List;

/**
 * What applying the file would do, computed without writing anything. {@code locale} and {@code willWriteTo} are null
 * when the file has no enabled locale; {@code errors} are the problems of the whole file. {@code pack} says what the ZIP
 * package holds and is null for a plain {@code .md} file; {@code notes} are the images of a package that nothing uses
 * (they are not stored).
 */
public record PreviewResponse(
        String sha256,
        long bytes,
        String schemaVersion,
        String contentType,
        String locale,
        String willWriteTo,
        List<ImportProblem> errors,
        List<IgnoredItem> ignored,
        int ignoredTotal,
        List<PreviewSection> sections,
        PostPackageFacts pack,
        List<PostImportNote> notes) {}
