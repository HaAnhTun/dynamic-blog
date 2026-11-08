package com.blog.postimport.dto;

import java.util.List;

/**
 * The article of one file as its uploader will see it, for the page that previews it before an import. Only the caller who
 * uploaded the file receives it, so it carries the text of the file; nothing here is stored or logged.
 *
 * @param fileName the name the file was uploaded with
 * @param title the front matter values the article header needs; null when the file gives none
 * @param body the Markdown body exactly as written (a package's references still point at its own files), null when the file
 *     could not be read
 * @param bodyLine the 1-based line of the file where the body starts, 0 when there is none; a line number of the body plus this
 *     minus one is the line of the file
 * @param assets the images of a package that the body uses, as uploaded, with the size their header declares
 * @param pkg the facts of the package, null for a Markdown file and for a package that could not be read
 * @param problems at most {@code PostFileLimits.MAX_PROBLEMS_PER_RESPONSE} problems of the file; {@code problemsTotal} counts them all
 */
public record PostArticlePreviewResponse(
        String fileName,
        String title,
        String excerpt,
        String category,
        List<String> tags,
        String language,
        String slug,
        String body,
        int bodyLine,
        List<Asset> assets,
        PostPackageFacts pkg,
        List<PostImportProblem> problems,
        int problemsTotal) {

    /**
     * One image of a package.
     *
     * @param path the path relative to the article, as the body names it once normalized ({@code assets/figure-1.png})
     * @param contentType {@code image/jpeg}, {@code image/png} or {@code image/webp}
     * @param base64 the bytes as uploaded
     * @param width the width the header declares, 0 when it could not be read
     * @param height the height the header declares, 0 when it could not be read
     */
    public record Asset(String path, String contentType, String base64, int width, int height) {}
}
