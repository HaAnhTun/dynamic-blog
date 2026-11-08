package com.blog.postimport.dto;

import java.util.List;

/**
 * The preview of an upload: one entry per file in upload order, and what the page needs to say about the whole upload.
 *
 * @param filesWithProblems the positions of the files in state {@code error}
 * @param problemsOmitted problems that were counted but not listed because of the cap per answer
 * @param newCategoryCount categories the import would create, once each over all files that have no problem
 * @param newTagCount tags the import would create, likewise
 * @param newSeriesCount series the import would create, likewise
 * @param totalBytes the sum of the file sizes
 */
public record PostPreviewResponse(
        List<PostPreviewFile> files,
        List<Integer> filesWithProblems,
        int problemsOmitted,
        int newCategoryCount,
        int newTagCount,
        int newSeriesCount,
        int totalBytes) {}
