package com.blog.postimport.dto;

import com.blog.postimport.format.ParsedPost.Ignored;
import java.util.List;

/**
 * The preview of one post file. Only the caller who uploaded the file receives it, so it may carry the file name, the slug,
 * the title, description and category (cut) and the names to create; it never carries the body.
 *
 * @param position 1-based place of the file in the upload
 * @param bytes size of the file
 * @param sha256 lower case hex SHA-256 of the bytes exactly as uploaded
 * @param slug the final slug, null when it could not be made
 * @param slugSource {@code file_name} or {@code title} when the slug did not come from the {@code slug} key, else null
 * @param language the language of the post (the site default when the file names none), null when the file's is invalid
 * @param state one of {@link #NEW}, {@link #WILL_CHANGE}, {@link #UNCHANGED}, {@link #ERROR}
 * @param changes what the file changes, null for an error
 * @param newCategories names of the categories this file makes the import create
 * @param newTags names of the tags this file makes the import create
 * @param newSeries the name of the series this file makes the import create, none or one (administrators only)
 * @param problems at most the cap of problems; {@code problemsTotal} counts them all
 * @param ignored keys the format does not know, at most {@code PostFileLimits.MAX_IGNORED}; {@code ignoredTotal} counts them all
 * @param previewState the opaque state the apply compares, null unless the state is new or will change; carries no text
 * @param pkg the facts of the file's ZIP package, null for a Markdown file and for a package that could not be read
 */
public record PostPreviewFile(
        int position,
        String fileName,
        int bytes,
        String sha256,
        String slug,
        String slugSource,
        String language,
        String state,
        PostPreviewChanges changes,
        List<PostImportNote> notes,
        List<String> newCategories,
        List<String> newTags,
        List<String> newSeries,
        List<PostImportProblem> problems,
        int problemsTotal,
        List<Ignored> ignored,
        int ignoredTotal,
        String previewState,
        PostPackageFacts pkg) {

    public static final String NEW = "new";
    public static final String WILL_CHANGE = "will_change";
    public static final String UNCHANGED = "unchanged";
    public static final String ERROR = "error";
}
