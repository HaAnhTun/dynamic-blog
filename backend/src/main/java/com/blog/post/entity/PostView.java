package com.blog.post.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.util.UUID;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;
import org.hibernate.annotations.Immutable;

/**
 * The views of a post: one row per post in {@code post_views}.
 *
 * Read-only through JPA ({@link Immutable}: Hibernate keeps no snapshot for dirty checking and never issues an UPDATE
 * for it). The counter only goes up through one atomic native upsert: reading and writing back through the entity
 * would lose views when two readers arrive at the same time.
 *
 * Deliberately no relation to {@link Post} and nothing about views on Post: views are looked up in a batch for a whole
 * page of posts (PostViewRepository.findAllByPostIdIn), and a {@code @Formula} on Post was measured to break every
 * native query {@code select p.*}.
 */
@Entity
@Table(name = "post_views")
@Immutable
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class PostView {

    @Id
    @Column(name = "post_id")
    private UUID postId;

    @Column(name = "view_count", nullable = false)
    private long viewCount;

    public PostView(UUID postId, long viewCount) {
        this.postId = postId;
        this.viewCount = viewCount;
    }
}
