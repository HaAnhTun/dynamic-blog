package com.blog.gallery.entity;

import com.blog.media.entity.Media;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.Instant;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.UUID;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * A photo in the site owner's gallery. The image (metadata, bytes, alt text) is a {@link Media}; only the
 * gallery-specific part lives here. Deleting a gallery photo deletes its Media: the ON DELETE CASCADE foreign key (V17)
 * takes this row with it.
 *
 * {@code published = false} means hidden from the list, not private: the image URL is still served.
 */
@Entity
@Table(name = "gallery_photos")
@Getter
@Setter
@NoArgsConstructor
public class GalleryPhoto {

    /** Maximum caption length, counted by character after trimming (the column is TEXT; the limit is an application rule). */
    public static final int CAPTION_MAX_LENGTH = 1000;

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "media_id", nullable = false, unique = true)
    private Media media;

    private String caption;

    /** Date taken, no time zone; null when nobody said and EXIF has none either. */
    @Column(name = "taken_on")
    private LocalDate takenOn;

    /** Smaller comes first. Not unique: for equal values the later-created photo comes first. */
    @Column(name = "sort_order", nullable = false)
    private int sortOrder;

    @Column(nullable = false)
    private boolean published;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @PrePersist
    protected void onCreate() {
        Instant now = now();
        createdAt = now;
        updatedAt = now;
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = now();
    }

    /**
     * Truncates to microseconds, the precision of TIMESTAMPTZ: the upload and edit responses return the in-memory value,
     * and the admin screen compares it with the list re-read from the DB. The JVM clock (Windows, recent Linux) has
     * digits below the microsecond, so without truncation the same moment would come back as two different values.
     */
    public static Instant now() {
        return Instant.now().truncatedTo(ChronoUnit.MICROS);
    }
}
