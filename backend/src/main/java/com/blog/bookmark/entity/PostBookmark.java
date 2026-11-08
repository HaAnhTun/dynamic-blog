package com.blog.bookmark.entity;

import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;
import java.time.Instant;
import lombok.AccessLevel;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.Immutable;

/**
 * One bookmarked post ({@code post_bookmarks}, V29). Like PostLike: saving and unsaving are SQL in the repository,
 * so there is nothing for Hibernate to write; no relation to Post or User.
 */
@Entity
@Table(name = "post_bookmarks")
@Immutable
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class PostBookmark {

    @EmbeddedId
    private PostBookmarkId id;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;
}
