package com.blog.comment.entity;

import com.blog.post.entity.Post;
import com.blog.user.entity.User;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * A comment ({@code comments}, V19): a root when {@code parentId} is null, otherwise a reply exactly one level deep.
 *
 * The entity is read-only (tests also use it to build data). Insertion, only while the post is published, and
 * every later change (edit content, hide, show again, soft delete) is a conditional SQL statement in
 * CommentRepository, and the number of rows it changes decides the outcome: when an admin hides and the author
 * edits at the same time, neither overwrites the other's status. That is why EVERY column is updatable = false:
 * saving a loaded entity cannot write a stale value over a change that was just committed, and
 * {@code parent_id} is immutable so the "one level only" check has no race.
 */
@Entity
@Table(name = "comments")
@Getter
@Setter
@NoArgsConstructor
public class Comment {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "post_id", nullable = false, updatable = false)
    private Post post;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "user_id", nullable = false, updatable = false)
    private User author;

    /** The root comment this replies to; null when it is itself a root. The foreign key forces the parent onto the same post. */
    @Column(name = "parent_id", updatable = false)
    private UUID parentId;

    /** Stored verbatim after normalization (UserText.clean); rendered as text only, never as HTML. */
    @Column(nullable = false, updatable = false)
    private String content;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, updatable = false)
    private CommentStatus status = CommentStatus.VISIBLE;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false, updatable = false)
    private Instant updatedAt;

    /** Most recent content edit; null when never edited (the "edited" label in the UI). */
    @Column(name = "edited_at", updatable = false)
    private Instant editedAt;

    @PrePersist
    void onCreate() {
        // Truncate to microseconds, the precision Postgres stores: the keyset cursor (created_at, id) compares this
        // value exactly, so the in-memory value must equal the value read back from the DB.
        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
        createdAt = now;
        updatedAt = now;
    }
}
