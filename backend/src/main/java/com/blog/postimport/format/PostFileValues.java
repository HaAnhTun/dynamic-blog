package com.blog.postimport.format;

import java.util.List;

/**
 * The values of one post file: what the parser reads from a file and what the writer puts into one. A key that is absent
 * or empty is null (and {@code tags} is empty). {@code featured} and {@code status} are carried only so that the import can
 * report them; it never writes them.
 *
 * @param slug the final slug when read from a file (see {@link SlugSource}); the stored slug when written
 * @param tags tag names in file order, never null
 * @param translationOf the slug of the post this one translates
 * @param series the name of the series the post belongs to, at most {@link PostFileLimits#MAX_SERIES_CHARS} characters
 * @param seriesPart the declared part, a whole number from 1 to {@link PostFileLimits#MAX_SERIES_PART}
 * @param seriesDescription the description a series gets when the import creates it or finds it without one, never replacing
 *     a description that is there
 * @param cover the path of the cover image inside a ZIP package, as written in the file
 * @param coverAlt the one line of alternative text of the cover, at most {@code Media.ALT_TEXT_MAX_LENGTH} characters
 * @param content the Markdown body, verbatim
 */
public record PostFileValues(
        String title,
        String slug,
        String language,
        String excerpt,
        String category,
        List<String> tags,
        Boolean featured,
        String status,
        String translationOf,
        String series,
        Integer seriesPart,
        String seriesDescription,
        String cover,
        String coverAlt,
        String content) {

    public PostFileValues {
        tags = tags == null ? List.of() : List.copyOf(tags);
    }

    /** A file without cover keys. */
    public PostFileValues(
            String title,
            String slug,
            String language,
            String excerpt,
            String category,
            List<String> tags,
            Boolean featured,
            String status,
            String translationOf,
            String series,
            Integer seriesPart,
            String seriesDescription,
            String content) {
        this(
                title,
                slug,
                language,
                excerpt,
                category,
                tags,
                featured,
                status,
                translationOf,
                series,
                seriesPart,
                seriesDescription,
                null,
                null,
                content);
    }

    /** A file without series keys, which is what the writer writes. */
    public PostFileValues(
            String title,
            String slug,
            String language,
            String excerpt,
            String category,
            List<String> tags,
            Boolean featured,
            String status,
            String translationOf,
            String content) {
        this(
                title,
                slug,
                language,
                excerpt,
                category,
                tags,
                featured,
                status,
                translationOf,
                null,
                null,
                null,
                null,
                null,
                content);
    }
}
