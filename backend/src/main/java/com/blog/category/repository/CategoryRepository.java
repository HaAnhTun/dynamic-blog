package com.blog.category.repository;

import com.blog.category.entity.Category;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

public interface CategoryRepository extends JpaRepository<Category, UUID> {
    boolean existsByNameIgnoreCase(String name);

    /** Same as above, except the category being edited: changing the case of its own name is not a clash. */
    boolean existsByNameIgnoreCaseAndIdNot(String name, UUID id);

    boolean existsBySlug(String slug);

    /** Every category by name, including ones with no posts or only drafts: for the admin area only. */
    List<Category> findAllByOrderByNameAsc();

    /**
     * Categories with at least one published post, by name: exactly the categories the public side may see. A
     * category with only drafts is the name of a topic not yet written up and must not leak; same as
     * SeriesRepository#countWithPublishedParts for series.
     */
    @Query("""
            select c from Category c
            where exists (select 1 from Post p
                          where p.category = c and p.status = com.blog.post.entity.PostStatus.PUBLISHED)
            order by c.name asc""")
    List<Category> findAllWithPublishedPosts();

    /** Like {@link #findAllWithPublishedPosts}, counting only published posts written in {@code language}. */
    @Query("""
            select c from Category c
            where exists (select 1 from Post p
                          where p.category = c and p.status = com.blog.post.entity.PostStatus.PUBLISHED
                            and p.language = :language)
            order by c.name asc""")
    List<Category> findAllWithPublishedPostsIn(String language);

    /** Like {@link #findAllWithPublishedPosts}, for one slug: empty both when no category has it and when none is live. */
    @Query("""
            select c from Category c
            where c.slug = :slug
              and exists (select 1 from Post p
                          where p.category = c and p.status = com.blog.post.entity.PostStatus.PUBLISHED)""")
    Optional<Category> findBySlugWithPublishedPosts(String slug);

    /** Number of posts using the category, any status: drafts also hold the foreign key {@code posts.category_id}. */
    @Query("select count(p) from Post p where p.category.id = :id")
    long countPosts(UUID id);

    /**
     * The category with a FOR UPDATE lock on its row, held until the transaction ends. Update and delete go through here.
     *
     * Hand-written rather than {@code @Lock(PESSIMISTIC_WRITE)} like the other repositories: on PostgreSQL, Hibernate
     * translates PESSIMISTIC_WRITE to FOR NO KEY UPDATE, and that lock deliberately does NOT block FOR KEY SHARE, the lock
     * Postgres takes on the category row on every foreign key check of {@code posts.category_id} (a post created in, or
     * moved into, this category). Only FOR UPDATE blocks it, so "count posts then delete" has no gap: if a post is
     * assigned first, the delete waits for that assignment to commit and then counts the post (409 CATEGORY_IN_USE); if
     * assigned afterwards, the assignment waits for the delete to commit and then fails on the foreign key. With a weaker
     * lock, the delete counts 0 posts and then the DELETE statement itself trips over the foreign key at commit.
     *
     * An update only needs the lock so that a concurrent delete makes it wait and then find the category gone (404),
     * instead of writing to a row that was just deleted and ending in a 500; it shares this lock for simplicity.
     */
    @Query(value = "select * from categories where id = :id for update", nativeQuery = true)
    Optional<Category> findByIdForUpdate(UUID id);

    // --- Merging categories ------------------------------------------------------------------------------

    /**
     * The categories in {@code ids}, locked FOR UPDATE in id order (Postgres locks each row as it leaves the ORDER BY),
     * held until the transaction ends: two merges in opposite directions lock in the same order and never lock
     * crosswise. FOR UPDATE for the same reason as {@link #findByIdForUpdate}: a post assigned to the source category
     * just as the merge runs either commits first and is moved, or waits for the merge to commit and then fails on the
     * foreign key; no post is left in a deleted category.
     */
    @Query(value = "select * from categories where id in (:ids) order by id for update", nativeQuery = true)
    List<Category> findAllByIdForUpdate(Collection<UUID> ids);

    /**
     * Moves every post, any status, from one category to another; returns the number of posts moved. Plain SQL, not
     * through the Post entity: leaves {@code updated_at} alone (bulk recategorising is an editorial act, not a post
     * edit). Does not clear the persistence context: the merge loads no post, and the locked categories are still used.
     */
    @Modifying
    @Query(value = "update posts set category_id = :targetId where category_id = :sourceId", nativeQuery = true)
    int movePosts(UUID sourceId, UUID targetId);
}
