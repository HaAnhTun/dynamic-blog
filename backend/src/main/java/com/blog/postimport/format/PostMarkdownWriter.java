package com.blog.postimport.format;

import com.blog.media.entity.Media;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Writes a post as a post file, in the dialect of the "Download .md" button ({@code frontend/lib/post-markdown.ts}): a
 * comment line, then {@code title}, {@code excerpt}, {@code category}, {@code tags}, {@code featured}, {@code status}, then
 * the keys the import reads, {@code slug}, {@code language} and {@code translation_of} (the last two only when there is a
 * value), then the series keys and the cover keys (only for a post with a series, and only for a post whose cover goes into
 * a package), then the body verbatim. Every value is on one line in its {@linkplain PostNormalForm normal form}, so what the
 * parser reads back is that normal form, and a file the developer script reads keeps working.
 *
 * <p>The template generator reuses the line and body formats, so the template and a download cannot drift apart.
 */
public final class PostMarkdownWriter {

    /** The first line of the front matter of a download. */
    static final String DOWNLOAD_COMMENT =
            "# Exported from the admin. \"status\" is informational only: seed/push.py publishes every file it pushes.";

    private static final String FENCE = "---";

    private PostMarkdownWriter() {}

    /** The whole file: the front matter, a blank line, the body (with one final line feed when it has none). */
    public static String write(PostFileValues values) {
        List<String> meta = new ArrayList<>();
        meta.add(DOWNLOAD_COMMENT);
        meta.add(keyLine(PostKey.TITLE, PostNormalForm.line(values.title())));
        meta.add(keyLine(PostKey.EXCERPT, PostNormalForm.line(values.excerpt())));
        meta.add(keyLine(PostKey.CATEGORY, PostNormalForm.line(values.category())));
        meta.add(keyLine(PostKey.TAGS, tags(values.tags())));
        meta.add(keyLine(PostKey.FEATURED, Boolean.TRUE.equals(values.featured()) ? "true" : "false"));
        meta.add(keyLine(PostKey.STATUS, PostNormalForm.line(values.status())));
        meta.add(keyLine(PostKey.SLUG, PostNormalForm.line(values.slug())));
        String language = PostNormalForm.line(values.language());
        if (!language.isEmpty()) {
            meta.add(keyLine(PostKey.LANGUAGE, language));
        }
        String translationOf = PostNormalForm.line(values.translationOf());
        if (!translationOf.isEmpty()) {
            meta.add(keyLine(PostKey.TRANSLATION_OF, translationOf));
        }
        addSeries(meta, values);
        addCover(meta, values);
        return frontMatter(meta) + "\n" + body(values.content());
    }

    /**
     * The series keys, last: only for a post that is in a series and has a declared part (the import refuses a series without
     * a part for a post that is not in the series yet). The description is cut to the cap of the format.
     */
    private static void addSeries(List<String> meta, PostFileValues values) {
        String series = PostNormalForm.line(values.series());
        if (series.isEmpty() || values.seriesPart() == null) {
            return;
        }
        meta.add(keyLine(PostKey.SERIES, series));
        meta.add(keyLine(PostKey.SERIES_PART, String.valueOf(values.seriesPart())));
        String description = PostNormalForm.line(values.seriesDescription());
        if (description.codePointCount(0, description.length()) > PostFileLimits.MAX_SERIES_DESCRIPTION_CHARS) {
            description = description.substring(
                    0, description.offsetByCodePoints(0, PostFileLimits.MAX_SERIES_DESCRIPTION_CHARS));
        }
        if (!description.isEmpty()) {
            meta.add(keyLine(PostKey.SERIES_DESCRIPTION, description));
        }
    }

    /**
     * The cover keys, last, only for a post whose cover goes into the package next to the file. The description is cut to the
     * cap of the format.
     */
    private static void addCover(List<String> meta, PostFileValues values) {
        String cover = PostNormalForm.line(values.cover());
        if (cover.isEmpty()) {
            return;
        }
        meta.add(keyLine(PostKey.COVER, cover));
        String alt = PostNormalForm.line(values.coverAlt());
        if (alt.length() > Media.ALT_TEXT_MAX_LENGTH) {
            int end = Character.isHighSurrogate(alt.charAt(Media.ALT_TEXT_MAX_LENGTH - 1))
                    ? Media.ALT_TEXT_MAX_LENGTH - 1
                    : Media.ALT_TEXT_MAX_LENGTH;
            alt = alt.substring(0, end);
        }
        if (!alt.isEmpty()) {
            meta.add(keyLine(PostKey.COVER_ALT, alt));
        }
    }

    /** {@code key: value}, or just {@code key:} for an empty value (a value is already on one line). */
    static String keyLine(PostKey key, String value) {
        return key.keyName() + ":" + (value.isEmpty() ? "" : " " + value);
    }

    /** The two fences around the lines, each line ending with a line feed. */
    static String frontMatter(List<String> lines) {
        return FENCE + "\n" + String.join("\n", lines) + "\n" + FENCE + "\n";
    }

    /** The body as written: verbatim, with a line feed at the end when it has none. */
    static String body(String content) {
        String text = content == null ? "" : content;
        return text.endsWith("\n") ? text : text + "\n";
    }

    private static String tags(List<String> names) {
        return names.stream()
                .map(PostNormalForm::tag)
                .filter(name -> !name.isEmpty())
                .collect(Collectors.joining(", "));
    }
}
