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
 * A comment like ({@code comment_likes}, V21): one row per (comment, user), like {@link PostLike}.
 *
 * {@link Immutable}: Hibernate never issues an UPDATE for it. Liking is {@code INSERT ... ON CONFLICT DO NOTHING}
 * only while the comment is VISIBLE on a published post, unliking is {@code DELETE}, counting is
 * {@code count(*)}, all as queries in CommentLikeRepository. No relation to Comment or User: no read path needs to
 * load them through a like.
 */
@Entity
@Table(name = "comment_likes")
@Immutable
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class CommentLike {

    @EmbeddedId
    private CommentLikeId id;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    public CommentLike(CommentLikeId id) {
        this.id = id;
    }

    @PrePersist
    void onCreate() {
        createdAt = Instant.now();
    }
}
