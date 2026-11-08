package com.blog.post.repository;

import com.blog.post.entity.PostCard;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Query;

/**
 * Every list of posts, read WITHOUT the body: the entity is {@link PostCard}, the row of {@code posts} minus its text (issue 013).
 * Before, each list loaded the whole text of each post it showed and computed the reading time from it. The statements that
 * return the full post (one post by id or slug, the lock, the writes) stay in {@link PostRepository}.
 *
 * A native statement here selects {@link PostCard#COLUMNS}, never {@code p.*}: the body would still travel from the database.
 */
public interface PostCardRepository extends JpaRepository<PostCard, UUID>, JpaSpecificationExecutor<PostCard> {

    /**
     * Every featured post, any status, in "Featured posts" order: the admin screen must also see the featured drafts in
     * their place. A post with no rank yet (just featured) stands after the ranked ones; among those, the most recently
     * published first, drafts (no publish date) last. {@code createdAt} only makes the order deterministic among drafts,
     * so the sortable list does not reverse itself between two loads.
     */
    @Query("""
            select p from PostCard p
            where p.featured = true
            order by p.featuredRank asc nulls last, p.publishedAt desc nulls last, p.createdAt desc""")
    List<PostCard> findAllFeaturedByRank();

    /** Every post of the given series, any status, by position: the admin series screen. */
    @Query("select p from PostCard p where p.series.id in :seriesIds order by p.seriesPosition")
    List<PostCard> findAllInSeries(Collection<UUID> seriesIds);

    /**
     * The published parts of a series in reading order. The position is unique within a series (constraint
     * {@code uq_posts_series_position}), so this order is already deterministic and matches the order {@link
     * PostRepository#findPartNumbers} numbers by.
     */
    @Query("""
            select p from PostCard p
            where p.series.id = :seriesId and p.status = com.blog.post.entity.PostStatus.PUBLISHED
            order by p.seriesPosition""")
    List<PostCard> findPublishedInSeries(UUID seriesId);

    /**
     * Every published part of every series, with its series (join fetch: one query for the whole /series page), by
     * position. The caller groups by series; the order inside each group is the reading order.
     */
    @Query("""
            select p from PostCard p join fetch p.series
            where p.status = com.blog.post.entity.PostStatus.PUBLISHED
            order by p.seriesPosition""")
    List<PostCard> findPublishedInAnySeries();

    /**
     * Published posts, most viewed first ({@code GET /api/v1/posts?sort=popular}).
     *
     * Left join: a post nobody has viewed has no row in post_views, and must still be present (0 views, at the end of
     * the list). On equal views the later-published post comes first, then the id: a deterministic order, so pagination
     * neither repeats nor skips posts between pages.
     *
     * Native because it sorts by a column of another table that the entity deliberately does not map (see PostView). Like
     * {@link PostRepository.Search}, the order lives in the SQL, so the caller must pass an UNSORTED Pageable: a Pageable
     * with a Sort makes Spring Data append a second ORDER BY and the statement breaks.
     */
    @Query(
            value = "select " + PostCard.COLUMNS + " from posts p "
                    + "left join post_views v on v.post_id = p.id "
                    + "where p.status = 'PUBLISHED' "
                    + "order by coalesce(v.view_count, 0) desc, p.published_at desc, p.id",
            countQuery = "select count(*) from posts p where p.status = 'PUBLISHED'",
            nativeQuery = true)
    Page<PostCard> findPopularPublished(Pageable pageable);

    /** {@link #findPopularPublished} for one language: a second statement, so the unfiltered one keeps its plan. */
    @Query(
            value = "select " + PostCard.COLUMNS + " from posts p "
                    + "left join post_views v on v.post_id = p.id "
                    + "where p.status = 'PUBLISHED' and p.language = :language "
                    + "order by coalesce(v.view_count, 0) desc, p.published_at desc, p.id",
            countQuery = "select count(*) from posts p where p.status = 'PUBLISHED' and p.language = :language",
            nativeQuery = true)
    Page<PostCard> findPopularPublishedInLanguage(String language, Pageable pageable);
}
