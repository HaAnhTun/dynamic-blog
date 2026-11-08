package com.blog.search.service;

import com.fasterxml.jackson.annotation.JsonValue;

/**
 * Result type of {@code GET /api/v1/search}. The declaration order is the group order in the answer, and the quick-search
 * panel draws the groups in exactly the order the backend returns; {@code TAB_TYPES} of
 * {@code frontend/lib/search-contract.ts} keeps the same order.
 */
public enum SearchType {
    POST("post"),
    TOPIC("topic"),
    SERIES("series"),
    CASE_STUDY("case-study"),
    AUTHOR("author"),
    PAGE("page");

    private final String value;

    SearchType(String value) {
        this.value = value;
    }

    @JsonValue
    public String value() {
        return value;
    }
}
