package com.blog.like.entity;

import jakarta.persistence.Column;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.Instant;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.Immutable;

/**
 * A like ({@code post_likes}, V20): one row per (post, user).
 *
 * There is nothing to edit on a like ({@link Immutable}: Hibernate never issues an UPDATE for it). Liking is
 * {@code INSERT ... ON CONFLICT DO NOTHING} only while the post is published, unliking is {@code DELETE},
 * counting is {@code count(*)}, all as SQL in the repository: two simultaneous likes produce exactly one row and
 * no duplicate-key error.
 *
 * Deliberately no relation to Post or User, like PostView: no read path needs to load them through a like.
 */
@Entity
@Table(name = "post_likes")
@Immutable
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class PostLike {

    @EmbeddedId
    private PostLikeId id;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public PostLike(PostLikeId id) {
        this.id = id;
    }

    @PrePersist
    void onCreate() {
        createdAt = Instant.now();
    }
}
