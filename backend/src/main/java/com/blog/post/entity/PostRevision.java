package com.blog.post.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.Table;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Objects;
import java.util.UUID;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;

/**
 * The text of a post at a point in time before an edit: title, excerpt, content. No slug, status or classification:
 * a restore only brings the text back.
 *
 * Invariant: every column is {@code updatable = false} and there is no setter. A revision is only added
 * (PostRevisionService) or deleted (keeping the newest 20, or deleting the post), never modified.
 */
@Entity
@Table(name = "post_revisions")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class PostRevision {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    /**
     * A plain column, not a relation to Post: nothing needs to load the post from a revision, and deleting the post
     * takes its revisions (CASCADE).
     */
    @Column(name = "post_id", nullable = false, updatable = false)
    private UUID postId;

    @Column(nullable = false, updatable = false)
    private String title;

    @Column(updatable = false)
    private String excerpt;

    @Column(nullable = false, updatable = false)
    private String content;

    /** When it was written, i.e. when this state was replaced; truncated to microseconds, the precision Postgres stores. */
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    /** Who saved the edit (or restore) that caused this revision to be written; null once that account is deleted. */
    @Column(name = "created_by", updatable = false)
    private UUID createdBy;

    /** The post's current text, written by {@code createdBy}. */
    public static PostRevision of(Post post, UUID createdBy) {
        PostRevision revision = new PostRevision();
        revision.postId = post.getId();
        revision.title = post.getTitle();
        revision.excerpt = post.getExcerpt();
        revision.content = post.getContent();
        revision.createdBy = createdBy;
        return revision;
    }

    /** Whether the post already carries exactly this text: restoring such a revision changes nothing. */
    public boolean hasSameText(Post post) {
        return title.equals(post.getTitle())
                && Objects.equals(excerpt, post.getExcerpt())
                && content.equals(post.getContent());
    }

    @PrePersist
    void onCreate() {
        createdAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }
}
