package com.blog.post.entity;

import com.blog.category.entity.Category;
import com.blog.media.entity.Media;
import com.blog.series.entity.Series;
import com.blog.tag.entity.Tag;
import com.blog.user.entity.User;
import jakarta.persistence.Column;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.JoinTable;
import jakarta.persistence.ManyToMany;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.MappedSuperclass;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import lombok.AccessLevel;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * Every column of {@code posts} except the body, shared by the two entities that map the table: {@link Post}, which adds the body
 * and is the only one that is written, and {@link PostCard}, a read-only view without the body for every list (issue 013: a list of
 * posts used to load the whole text of each one just to show a card). Code that only shows a post takes a {@code PostHead}, so it
 * cannot reach for the body by accident.
 *
 * {@code readingMinutes} is stored with the post and set whenever the body is set ({@link Post#setContent}); 0 only means "not
 * computed yet" for a row that existed before migration V47, and the backfill at startup fills it in.
 */
@MappedSuperclass
@Getter
@Setter
@NoArgsConstructor
public abstract class PostHead {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false)
    private String title;

    @Column(nullable = false, unique = true)
    private String slug;

    private String excerpt;

    /** Stored with the body (see {@link Post#setContent}), so a list can show it without reading the body; 0 = not computed yet. */
    @Column(name = "reading_minutes", nullable = false)
    private int readingMinutes;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private PostStatus status;

    /** One of the enabled locales (V34, V35). Author-controlled; every public list filters on it. */
    @Column(nullable = false)
    private String language;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "author_id", nullable = false)
    private User author;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "category_id")
    private Category category;

    @ManyToMany(fetch = FetchType.LAZY)
    @JoinTable(
            name = "post_tags",
            joinColumns = @JoinColumn(name = "post_id"),
            inverseJoinColumns = @JoinColumn(name = "tag_id"))
    private Set<Tag> tags = new HashSet<>();

    /**
     * Author-controlled, and read by the public homepage. The database column is NOT NULL
     * with a default of false, so an existing row keeps a definite value rather than a null
     * that every reader would have to defend against.
     *
     * The `search_vector` column added in the same sprint is deliberately absent from this
     * entity: it is GENERATED ALWAYS, Hibernate has no tsvector type, and the only statement
     * that touches it is one native query in PostRepository.
     */
    // Written only by a dedicated SQL statement (PostRepository.setFeatured, ranking): saving a post as its author does
    // not overwrite an admin's concurrent "Featured posts" decision.
    @Column(nullable = false, updatable = false)
    private boolean featured;

    // The four fields below are READ-ONLY on the entity: insertable/updatable = false, and there is no setter, so a
    // write through the entity does not compile. They are written only by dedicated SQL statements (attach a cover,
    // order a series, rank "Featured posts"), after which the service reloads the post. The entity has no
    // @DynamicUpdate, so every post save (PUT, publish, unpublish) rewrites every column it may write: if these four
    // columns were among them, a save overlapping a curation change that just happened would overwrite it with the
    // old value, and every curation change would bump updatedAt.
    //
    // The view count is deliberately not here (not even as a @Formula, which was measured to break every native query
    // that selects p.*): PostService looks it up in a batch for the whole page from post_views.

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "cover_media_id", insertable = false, updatable = false)
    @Setter(AccessLevel.NONE)
    private Media cover;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "series_id", insertable = false, updatable = false)
    @Setter(AccessLevel.NONE)
    private Series series;

    /**
     * Stored position in the series, which may have gaps; "Part n/m" is recounted from the published parts, not read
     * from here.
     */
    @Column(name = "series_position", insertable = false, updatable = false)
    @Setter(AccessLevel.NONE)
    private Integer seriesPosition;

    /**
     * The number the author declared for this post inside its series (an import writes it), null when none was declared.
     * {@code series_position} still orders the members; this is the number a reader is promised, unique per series and
     * language.
     */
    @Column(name = "series_part", insertable = false, updatable = false)
    @Setter(AccessLevel.NONE)
    private Integer seriesPart;

    /** Rank in "Featured posts", 1 is first; null when the post is not ranked. */
    @Column(name = "featured_rank", insertable = false, updatable = false)
    @Setter(AccessLevel.NONE)
    private Integer featuredRank;

    /**
     * Links the translations of one article (V34): posts that share an id are translations of each other, one per language
     * (unique with the language, V35). Read-only here and written only by PostRepository statements, like the cover: a post
     * saved by its author must not overwrite a link made at the same time by someone else.
     */
    @Column(name = "translation_group_id", insertable = false, updatable = false)
    @Setter(AccessLevel.NONE)
    private UUID translationGroupId;

    @Column(name = "published_at")
    private Instant publishedAt;

    /**
     * Set when an AUTHOR deleted the post (V49): the post is hidden (status ARCHIVED) and everything that hangs on it is kept. Null
     * for every post that is not hidden. An ADMIN deletes for good.
     */
    @Column(name = "deleted_at")
    private Instant deletedAt;

    @Column(name = "deleted_by")
    private UUID deletedBy;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    /**
     * Truncated to microseconds, the precision Postgres stores, like publishedAt (PostService.publish) and Comment: the
     * response of a write carries exactly the value that is read back afterwards, digit for digit (the editor's
     * autosave compares this mark with the re-read post). Without truncation a finer clock (100 ns on Windows, ns on
     * Linux) would give a string different from the one the DB returns.
     */
    @PrePersist
    protected void onCreate() {
        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
        createdAt = now;
        updatedAt = now;
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }
}
