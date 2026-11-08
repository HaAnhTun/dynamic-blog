package com.blog.post.repository;

import java.util.UUID;

/**
 * One row of {@link PostRepository#findPartNumbers}: "Part n/m" of a published post within its series.
 * A projection interface, so Spring Data reads by column name; the SQL quotes its aliases so that the returned column
 * names are spelled exactly like the getters (Postgres lowercases every unquoted alias).
 */
public interface PartNumberRow {
    UUID getPostId();

    int getPartNumber();

    int getPartCount();
}
