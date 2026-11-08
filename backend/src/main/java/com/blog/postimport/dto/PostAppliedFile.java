package com.blog.postimport.dto;

import java.util.UUID;

/**
 * What the apply did with one file. {@code postId} and {@code slug} are set for a file that was written or found unchanged (the
 * page links to the editor with them) and null for a skipped one; only the caller who uploaded the file receives them.
 *
 * @param position 1-based place of the file in the upload
 * @param result one of {@link #CREATED}, {@link #UPDATED}, {@link #UNCHANGED}, {@link #SKIPPED}
 */
public record PostAppliedFile(int position, String fileName, String result, UUID postId, String slug) {

    /** A new draft post was made. */
    public static final String CREATED = "created";
    /** An existing post was changed. */
    public static final String UPDATED = "updated";
    /** The post already had every value the file supplies: nothing was written. */
    public static final String UNCHANGED = "unchanged";
    /** The file was not selected: nothing was read from it beyond its hash, nothing was written. */
    public static final String SKIPPED = "skipped";
}
