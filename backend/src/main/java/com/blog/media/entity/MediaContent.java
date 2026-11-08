package com.blog.media.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.PostLoad;
import jakarta.persistence.PostPersist;
import jakarta.persistence.Table;
import jakarta.persistence.Transient;
import java.util.UUID;
import lombok.AccessLevel;
import lombok.NoArgsConstructor;
import org.springframework.data.domain.Persistable;

/**
 * The bytes of an image; the primary key is the id of the {@link Media}. Written only once (at persist) and read only
 * through the {@code select c.data} projection of MediaContentRepository: loading the whole entity makes Hibernate keep
 * an extra 4 MB copy as a snapshot for dirty checking, for an array that never changes.
 *
 * The id is assigned by hand, so Spring Data cannot tell a new entity from an old one, and with a non-null id it would
 * {@code merge}: a redundant SELECT before every INSERT. {@link Persistable#isNew()} says plainly that it is new until
 * it has been saved or loaded.
 */
@Entity
@Table(name = "media_content")
@NoArgsConstructor(access = AccessLevel.PROTECTED)
public class MediaContent implements Persistable<UUID> {

    @Id
    @Column(name = "media_id")
    private UUID mediaId;

    /** byte[] without @Lob: on PostgreSQL @Lob is an oid column (large object), not bytea. */
    @Column(nullable = false)
    private byte[] data;

    @Transient
    private boolean persisted;

    public MediaContent(UUID mediaId, byte[] data) {
        this.mediaId = mediaId;
        this.data = data;
    }

    @Override
    public UUID getId() {
        return mediaId;
    }

    public byte[] getData() {
        return data;
    }

    @Override
    public boolean isNew() {
        return !persisted;
    }

    @PostPersist
    @PostLoad
    void markPersisted() {
        persisted = true;
    }
}
