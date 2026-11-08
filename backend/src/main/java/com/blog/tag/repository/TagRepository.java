package com.blog.tag.repository;

import com.blog.tag.entity.Tag;
import jakarta.persistence.LockModeType;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

public interface TagRepository extends JpaRepository<Tag, UUID> {
    boolean existsByNameIgnoreCase(String name);

    /** Same as above, except the tag being edited: changing the case of its own name is not a clash. */
    boolean existsByNameIgnoreCaseAndIdNot(String name, UUID id);

    boolean existsBySlug(String slug);

    /** Every tag by name, including ones attached to no post or only to drafts: for the admin area only. */
    List<Tag> findAllByOrderByNameAsc();

    /**
     * Tags attached to at least one published post, by name: exactly the tags the public side may see, like
     * CategoryRepository#findAllWithPublishedPosts.
     */
    @Query("""
            select t from Tag t
            where exists (select 1 from Post p join p.tags pt
                          where pt = t and p.status = com.blog.post.entity.PostStatus.PUBLISHED)
            order by t.name asc""")
    List<Tag> findAllWithPublishedPosts();

    /** Like {@link #findAllWithPublishedPosts}, counting only published posts written in {@code language}. */
    @Query("""
            select t from Tag t
            where exists (select 1 from Post p join p.tags pt
                          where pt = t and p.status = com.blog.post.entity.PostStatus.PUBLISHED
                            and p.language = :language)
            order by t.name asc""")
    List<Tag> findAllWithPublishedPostsIn(String language);

    /** Like {@link #findAllWithPublishedPosts}, for one slug: empty both when no tag has it and when none is live. */
    @Query("""
            select t from Tag t
            where t.slug = :slug
              and exists (select 1 from Post p join p.tags pt
                          where pt = t and p.status = com.blog.post.entity.PostStatus.PUBLISHED)""")
    Optional<Tag> findBySlugWithPublishedPosts(String slug);

    List<Tag> findAllByIdIn(Set<UUID> ids);

    /**
     * The tag with a write lock on its row, held until the transaction ends. Update and delete go through here: two
     * overlapping deletes (repeated click, two tabs), or an update running just as a delete does, make the later one
     * wait for the earlier to commit and then find the tag gone (404), instead of writing to a row that was just deleted
     * and ending in a 500.
     *
     * PESSIMISTIC_WRITE (FOR NO KEY UPDATE on PostgreSQL) is enough, unlike for categories: deleting a tag counts no
     * posts, so there is no need to block a post that is being tagged. That post either commits first and loses the tag
     * through ON DELETE CASCADE, or arrives later and is rejected because the tag no longer exists; the tag delete does
     * not fail in either case.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select t from Tag t where t.id = :id")
    Optional<Tag> findByIdForUpdate(UUID id);

    // --- Merging tags -----------------------------------------------------------------------------------

    /**
     * The tags in {@code ids}, locked FOR UPDATE in id order, held until the transaction ends. Two merges in opposite
     * directions (A into B, B into A) therefore lock in the same order and never lock crosswise: the later one waits for
     * the earlier to commit and then finds one of the two tags gone. Postgres locks each row as it leaves the ORDER BY,
     * so the order is the statement's order.
     *
     * FOR UPDATE rather than FOR NO KEY UPDATE like {@link #findByIdForUpdate}: only FOR UPDATE blocks FOR KEY SHARE, the
     * lock Postgres takes on the tag row when a post save attaches that tag (the foreign key check of post_tags). If the
     * source tag is attached first, the merge waits for the save to commit and then sees and moves that post; if
     * attached afterwards, the save waits for the merge to commit and then fails on the foreign key (the source tag is
     * gone). A post carrying the source tag never slips through the merge and loses its tag.
     */
    @Query(value = "select * from tags where id in (:ids) order by id for update", nativeQuery = true)
    List<Tag> findAllByIdForUpdate(Collection<UUID> ids);

    /** Number of posts carrying the tag, any status. */
    @Query(value = "select count(*) from post_tags where tag_id = :tagId", nativeQuery = true)
    long countPosts(UUID tagId);

    /**
     * Attaches the target tag to every post carrying the source tag; a post that already has the target tag keeps a
     * single row (primary key (post_id, tag_id), ON CONFLICT DO NOTHING). SQL on post_tags, not through the Post entity:
     * leaves the {@code updated_at} of every post alone. Does not clear the persistence context: the merge loads no
     * post, and the locked tags are still used.
     */
    @Modifying
    @Query(value = """
            insert into post_tags (post_id, tag_id)
            select post_id, :targetId from post_tags where tag_id = :sourceId
            on conflict do nothing""", nativeQuery = true)
    int copyPosts(UUID sourceId, UUID targetId);
}
