package com.blog.gallery.repository;

import com.blog.gallery.entity.GalleryPhoto;
import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Sort;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

public interface GalleryPhotoRepository extends JpaRepository<GalleryPhoto, UUID> {

    /** Visible photos, with their image (one JOIN, not one query per photo). */
    @EntityGraph(attributePaths = "media")
    Page<GalleryPhoto> findByPublishedTrue(Pageable pageable);

    /** All photos, hidden ones included, with their image: the admin screen needs the whole list to reorder it. */
    @EntityGraph(attributePaths = "media")
    @Override
    List<GalleryPhoto> findAll(Sort sort);

    /** Number of visible photos, for the site statistics ({@code GET /api/v1/stats}). */
    long countByPublishedTrue();

    /**
     * The order for a new photo so that it goes first: one unit lower than every existing photo; 0 when the gallery is
     * empty (reordering writes 1..n, so a new photo afterwards still goes first).
     */
    @Query("select coalesce(min(p.sortOrder), 1) - 1 from GalleryPhoto p")
    int nextTopSortOrder();

    /**
     * A photo with a write lock on its row, held until the end of the transaction. Edit and delete go through here: a
     * delete running exactly while an edit is (two tabs) makes the later one wait for the earlier to commit and then see
     * the true new state (photo gone, so 404), instead of writing to a row that was just deleted and ending in a 500.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select p from GalleryPhoto p where p.id = :id")
    Optional<GalleryPhoto> findByIdForUpdate(UUID id);

    /**
     * All photos, with a write lock on each row in id order, for one reorder. Locking in a fixed order means two
     * overlapping reorders (two tabs) never lock each other crosswise (deadlock): the later one waits for the earlier to
     * commit, reads the new list, then overwrites everything: exactly "the last save wins".
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select p from GalleryPhoto p order by p.id")
    List<GalleryPhoto> findAllForUpdate();

    /**
     * Writes the order of one photo with a single UPDATE statement, not through the entity: reordering is not editing
     * the photo, so {@code updated_at} does not change (no @PreUpdate runs).
     */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query("update GalleryPhoto p set p.sortOrder = :sortOrder where p.id = :id")
    int setSortOrder(UUID id, int sortOrder);
}
