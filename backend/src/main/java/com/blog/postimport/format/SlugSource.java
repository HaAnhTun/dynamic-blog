package com.blog.postimport.format;

/** Where the final slug of a post file came from, in the order they are tried. */
public enum SlugSource {
    /** The {@code slug} key. */
    KEY,
    /** The file name without its extension (the developer script's rule, so existing files keep their slugs). */
    FILE_NAME,
    /** Derived from the title, or {@code untitled} when there is none. */
    TITLE
}
