package com.blog.media.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * Metadata of an image that went through the pipeline. The bytes live in {@link MediaContent}, a separate table, so
 * that loading this entity (in post listings, the gallery) never drags the image along.
 *
 * Images are "unlisted, not private": anyone with the URL can view them, including the cover of a draft post. That
 * only holds because the id is a random UUID v4 (Hibernate {@link GenerationType#UUID}), which cannot be guessed or
 * enumerated.
 */
@Entity
@Table(name = "media")
@Getter
@Setter
@NoArgsConstructor
public class Media {

    /** Matches the VARCHAR(300) of the column; request DTOs use this constant for {@code @Size}. */
    public static final int ALT_TEXT_MAX_LENGTH = 300;

    public static final int ORIGINAL_FILENAME_MAX_LENGTH = 255;

    private static final String PNG = "image/png";

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    /** {@code image/jpeg} or {@code image/png}: the only two types the encoder writes (CHECK chk_media_content_type). */
    @Column(name = "content_type", nullable = false, length = 50)
    private String contentType;

    @Column(nullable = false)
    private int width;

    @Column(nullable = false)
    private int height;

    @Column(name = "byte_size", nullable = false)
    private int byteSize;

    /** Lowercase hex SHA-256 of exactly the stored bytes; also the ETag when serving. */
    @Column(nullable = false, length = 64)
    private String sha256;

    @Column(name = "dominant_color", length = 7)
    private String dominantColor;

    @Column(name = "alt_text", length = ALT_TEXT_MAX_LENGTH)
    private String altText;

    /** Admin-only: never copied to a public DTO (MediaResponse). */
    @Column(name = "original_filename", length = ORIGINAL_FILENAME_MAX_LENGTH)
    private String originalFilename;

    /**
     * A plain column, not a relation to User: nothing needs to load the uploader from an image, and
     * {@code ON DELETE SET NULL} already handles a deleted account.
     */
    @Column(name = "uploaded_by")
    private UUID uploadedBy;

    /**
     * The post that owns the image when it is an image in a post body (V25); null for covers and gallery photos, which
     * belong to their owner through the foreign key on the owning side. A plain column, not a relation to Post, like
     * {@code uploadedBy}: nothing needs to load the post from an image. Written once at store time
     * ({@code updatable = false}): an image does not move between posts. Deleting a post makes the DB delete the image
     * ({@code ON DELETE CASCADE}), and the bytes follow.
     */
    @Column(name = "post_id", updatable = false)
    private UUID postId;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @PrePersist
    protected void onCreate() {
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = Instant.now();
    }

    /**
     * Extension of the public URL, derived from the STORED type. One URL (and one cache key) per image:
     * {@code GET /api/v1/media/{id}.{ext}} with an extension other than this one is 404.
     */
    public String extension() {
        return PNG.equals(contentType) ? "png" : "jpg";
    }

    /** {@code <uuid>.jpg} or {@code <uuid>.png}: the only name the frontend uses to build the image path. */
    public String fileName() {
        return id + "." + extension();
    }
}
