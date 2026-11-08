package com.blog.search.index;

import java.util.Arrays;
import java.util.Optional;

/**
 * Type of a document in the index (field {@code type}) and its id prefix. The id is {@code <prefix><stable id>}: a uuid
 * for content in the DB, a slug for static content. Never split the id to read it: {@code type} and {@code sourceId}
 * are two separate fields.
 */
public enum DocType {
    POST("post", "post-"),
    CATEGORY("category", "category-"),
    TAG("tag", "tag-"),
    SERIES("series", "series-"),
    AUTHOR("author", "author-"),
    CASE_STUDY("case-study", "casestudy-"),
    PAGE("page", "page-");

    private final String value;
    private final String idPrefix;

    DocType(String value, String idPrefix) {
        this.value = value;
        this.idPrefix = idPrefix;
    }

    public String value() {
        return value;
    }

    public String documentId(String sourceId) {
        return idPrefix + sourceId;
    }

    /** Content that lives in the DB (uuid), not in the static content file. */
    public boolean fromDatabase() {
        return this != CASE_STUDY && this != PAGE;
    }

    public static Optional<DocType> of(String value) {
        return Arrays.stream(values()).filter(type -> type.value.equals(value)).findFirst();
    }
}
