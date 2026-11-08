package com.blog.post.entity;

import jakarta.persistence.Entity;
import jakarta.persistence.Table;
import java.util.Arrays;
import java.util.List;
import lombok.Getter;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.Immutable;

/**
 * The row of a post WITHOUT its body: a read-only view for every list (public lists, search, popular, featured, series, bookmarks,
 * the admin list). A list used to load the full text of each post it showed, and compute its reading time from it, which cost
 * memory and time in proportion to the size of the posts (issue 013). {@link PostHead} has no body, so nothing that takes a
 * card can read it.
 *
 * Never written: {@code @Immutable}. A native query that fills it must select {@link #COLUMNS} and not {@code p.*}, or the body
 * would still travel from the database; {@code PostCardIT} keeps the list equal to the table.
 */
@Entity
@Immutable
@Table(name = "posts")
@Getter
@NoArgsConstructor
public class PostCard extends PostHead {

    /**
     * The select list of a native query that fills a card, for a table aliased {@code p}: every column of {@code posts} that a
     * card maps, which is all of them but the body and the generated search vector. A constant, so that it can be used in a
     * {@code @Query}.
     */
    public static final String COLUMNS =
            "p.id, p.title, p.slug, p.excerpt, p.status, p.language, p.author_id, p.category_id, "
                    + "p.featured, p.cover_media_id, p.series_id, p.series_position, p.series_part, p.featured_rank, "
                    + "p.translation_group_id, p.published_at, p.deleted_at, p.deleted_by, p.created_at, p.updated_at, p.reading_minutes";

    /** The same columns, unqualified, for a test that compares them with the table. */
    public static List<String> columnNames() {
        return Arrays.stream(COLUMNS.split(", "))
                .map(column -> column.substring("p.".length()))
                .toList();
    }
}
