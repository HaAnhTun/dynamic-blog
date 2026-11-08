package com.blog.siteimport.format;

/** What a missing optional value becomes when a row or a list item is created from the file. */
public enum Fill {
    /** The property is left out of the JSON. */
    OMIT,
    /** The property is an explicit null. */
    NULL,
    /** The property is an empty string. */
    EMPTY
}
