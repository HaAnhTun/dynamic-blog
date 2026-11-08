package com.blog.postimport.dto;

/**
 * What a file changes in a post. For a new post {@code before} is null everywhere and the tag counts are all "added".
 * Texts are cut to {@code PostFileLimits.MAX_CHANGE_TEXT_CHARS} characters.
 *
 * @param contentDiffers whether the body differs from the stored one (always true for a new post)
 * @param linkWillBeAdded whether a translation link will be created
 * @param series the title of the series the post is in now and of the one it joins (the file's name for a series to create);
 *     null when the file changes nothing about the series, and always null for an author
 * @param seriesPart the part the post has now and the one the file declares; null exactly when {@code series} is
 */
public record PostPreviewChanges(
        Change title,
        Change description,
        Change category,
        int tagsAdded,
        int tagsRemoved,
        int tagsKept,
        boolean contentDiffers,
        boolean linkWillBeAdded,
        Change series,
        PartChange seriesPart) {

    /** The text before and after; either may be null (no text). */
    public record Change(String before, String after) {}

    /** The declared part before and after; the one before is null for a post that has none. */
    public record PartChange(Integer before, Integer after) {}
}
