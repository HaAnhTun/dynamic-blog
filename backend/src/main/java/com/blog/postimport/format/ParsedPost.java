package com.blog.postimport.format;

import java.util.List;
import java.util.Map;

/**
 * What the parser makes of one post file. It is purely syntactic: nothing here has been compared with what is stored, and
 * nothing is required (a title is needed only for a new post, which the import decides). {@code problems} are blocking: a
 * file with any problem cannot be imported. Nothing in a problem message is taken from the file.
 *
 * @param position 1-based position of the file in the upload; how a file is named in answers and logs
 * @param values what the file gave; a value with a problem is null
 * @param slugSource where {@code values.slug()} came from, null when there is no slug (a problem was found)
 * @param lines the 1-based line of every recognised key the file contains, empty values included
 * @param bodyLine the 1-based line where the body starts, 0 when the file has no body (a valid file may have none)
 * @param unreadable true when the front matter could not be read at all (no opening fence, or never closed): the file has no
 *     values and exactly one problem, and nothing that depends on its content may be said about it
 * @param ignored keys the format does not know, at most {@link PostFileLimits#MAX_IGNORED}
 * @param ignoredTotal how many unknown keys the file has, including those not listed
 */
public record ParsedPost(
        int position,
        PostFileValues values,
        SlugSource slugSource,
        Map<PostKey, Integer> lines,
        int bodyLine,
        boolean unreadable,
        List<Ignored> ignored,
        int ignoredTotal,
        List<Problem> problems) {

    /** A file that could not be read (a ZIP package that was refused): no values and the one problem. */
    public static ParsedPost refused(int position, String message) {
        PostFileValues none = new PostFileValues(null, null, null, null, null, List.of(), null, null, null, "");
        return new ParsedPost(
                position,
                none,
                null,
                Map.of(),
                0,
                true,
                List.of(),
                0,
                List.of(new Problem(position, null, null, message)));
    }

    /**
     * A blocking problem. {@code key} and {@code line} may be null; {@code message} never contains a value from the file
     * (only key names of the format and numbers).
     */
    public record Problem(int position, PostKey key, Integer line, String message) {}

    /**
     * A key the format does not know. {@code name} is set only for a plain word (1 to
     * {@link PostFileLimits#MAX_ECHOED_KEY_CHARS} ASCII letters, digits, underscores or hyphens); any other key is
     * reported by its line number alone.
     */
    public record Ignored(String name, int line) {}
}
