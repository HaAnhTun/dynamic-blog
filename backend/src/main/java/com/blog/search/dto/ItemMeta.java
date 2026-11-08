package com.blog.search.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.List;

/**
 * Secondary line of a result, by kind ({@code kind}), exactly the {@code ItemMeta} shape of
 * {@code frontend/lib/search-contract.ts}.
 * Public data only: no id, email, role or status.
 */
public sealed interface ItemMeta {

    /**
     * @param author only when the author is not the site owner: the owner's name on every row tells nothing
     * @param tags   at most 2 tag names
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    record PostMeta(
            String kind, String category, String author, Instant publishedAt, Integer readingMinutes, List<String> tags)
            implements ItemMeta {

        public PostMeta(
                String category, String author, Instant publishedAt, Integer readingMinutes, List<String> tags) {
            this("post", category, author, publishedAt, readingMinutes, tags);
        }
    }

    /**
     * @param kind  {@code category} or {@code tag}
     * @param count number of published posts
     */
    record TopicMeta(String kind, int count) implements ItemMeta {}

    /** @param parts number of published parts */
    record SeriesMeta(String kind, int parts) implements ItemMeta {

        public SeriesMeta(int parts) {
            this("series", parts);
        }
    }

    /** @param avatarUrl null when the account has no linked GitHub; always present in the JSON */
    record AuthorMeta(String kind, String avatarUrl) implements ItemMeta {

        public AuthorMeta(String avatarUrl) {
            this("author", avatarUrl);
        }
    }
}
