package com.blog.series.repository;

import com.blog.series.entity.Series;
import jakarta.persistence.LockModeType;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface SeriesRepository extends JpaRepository<Series, UUID> {
    Optional<Series> findBySlug(String slug);

    boolean existsBySlug(String slug);

    boolean existsBySlugAndIdNot(String slug, UUID id);

    /** A title that differs only in letter case counts as a duplicate, the same rule as the index {@code idx_series_title_lower} (V13). */
    boolean existsByTitleIgnoreCase(String title);

    /** As above, except the series being edited itself: changing the letter case of its own title is not a duplicate of anyone. */
    boolean existsByTitleIgnoreCaseAndIdNot(String title, UUID id);

    List<Series> findAllByOrderByTitleAsc();

    /**
     * Number of series with at least one published part: exactly the series that the public {@code /series} page lists (a
     * series with only drafts does not exist for readers). The "series" figure of the public statistics.
     */
    @Query("""
            select count(s) from Series s
            where exists (select 1 from Post p
                          where p.series = s and p.status = com.blog.post.entity.PostStatus.PUBLISHED)""")
    long countWithPublishedParts();

    /**
     * A series with a write lock on its row, held until the end of the transaction. Every membership write (and series
     * delete) goes through here: if the "detach the whole series, then assign 1..n" of two overlapping requests (double
     * save, two tabs) interleaved, the positions of one would hit the positions of the other on the unique constraint
     * (series_id, series_position) and one of them would become a 409. With the lock, the later one waits for the earlier
     * to commit and then replaces everything, exactly "the last save wins".
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select s from Series s where s.id = :id")
    Optional<Series> findByIdForUpdate(UUID id);
}
