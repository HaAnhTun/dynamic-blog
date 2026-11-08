package com.blog.post.repository;

import com.blog.post.entity.PostView;
import java.time.LocalDate;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

public interface PostViewRepository extends JpaRepository<PostView, UUID> {

    /**
     * The views of a whole page of posts in one query. A post nobody has viewed has no row: the caller treats missing
     * as 0.
     */
    List<PostView> findAllByPostIdIn(Collection<UUID> postIds);

    /**
     * Adds one view to the PUBLISHED post with this slug, in one statement: the first time it creates the counter, later
     * times it adds to it. Atomic inside the DB, so two readers at the same time make exactly two views; reading and
     * writing back through the entity would lose one. Records nothing about the reader (IP, user agent, time): the table
     * never grows longer than the number of posts.
     *
     * @return 1 when counted; 0 when no published post has that slug (unknown slug, unpublished post, unpublished again)
     */
    @Modifying
    @Query(value = """
            insert into post_views (post_id, view_count)
            select p.id, 1 from posts p where p.slug = :slug and p.status = 'PUBLISHED'
            on conflict (post_id) do update set view_count = post_views.view_count + 1
            """, nativeQuery = true)
    int incrementBySlug(String slug);

    /**
     * Adds one view to the (post, day, source group) row of {@code post_view_daily}, with the same kind of atomic upsert.
     * Only called after {@link #incrementBySlug} has counted, in the same transaction: the total row is locked first, the
     * daily row second. Does not filter by status again, so an unpublish committing between the two statements does not
     * leave the daily series missing a view the total already has.
     */
    @Modifying
    @Query(value = """
            insert into post_view_daily (post_id, day, source, views)
            select p.id, :day, :source, 1 from posts p where p.slug = :slug
            on conflict (post_id, day, source) do update set views = post_view_daily.views + 1
            """, nativeQuery = true)
    int incrementDailyBySlug(String slug, LocalDate day, String source);

    /**
     * Total views of the posts that are CURRENTLY published: the "views" figure of the public statistics. An unpublished
     * post keeps its counter (counting resumes on republish), but its views do not add to the total: the total must equal
     * the sum of the figures readers see on each post.
     */
    @Query(value = """
            select cast(coalesce(sum(v.view_count), 0) as bigint)
            from post_views v join posts p on p.id = v.post_id
            where p.status = 'PUBLISHED'
            """, nativeQuery = true)
    long sumForPublishedPosts();
}
