package com.blog.post.repository;

import com.blog.post.entity.Post;
import com.blog.post.entity.PostCard;
import com.blog.post.entity.PostStatus;
import jakarta.persistence.LockModeType;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.JpaSpecificationExecutor;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;

public interface PostRepository extends JpaRepository<Post, UUID>, JpaSpecificationExecutor<Post> {
    Optional<Post> findBySlug(String slug);

    /** Posts this author created after an instant, whatever their status: the count behind the posts-per-day limit. */
    long countByAuthorIdAndCreatedAtAfter(UUID authorId, Instant after);

    boolean existsBySlug(String slug);

    boolean existsBySlugAndIdNot(String slug, UUID id);

    /** Whether another post of the group already has this language. */
    @Query(value = """
            select exists (select 1 from posts where translation_group_id = :groupId and language = :language and id <> :postId)""", nativeQuery = true)
    boolean existsInTranslationGroup(UUID groupId, String language, UUID postId);

    /** Number of posts in a status; for PUBLISHED it is the "posts" figure of the public statistics. */
    long countByStatus(PostStatus status);

    /** Number of a person's posts in a status; for PUBLISHED it is {@code publishedPosts} of the public profile. */
    @Query("select count(p) from Post p where p.author.id = :authorId and p.status = :status")
    long countByAuthorIdAndStatus(UUID authorId, PostStatus status);

    /**
     * The author's id alone, for the ownership check in {@code PostAccessPolicy}.
     *
     * A projection rather than loading the entity, for two reasons. It runs on every write to
     * every post, so it should be one cheap indexed read and nothing else. And {@code author}
     * is a LAZY association with {@code open-in-view: false} — reading it off a loaded entity
     * works only because Hibernate can answer an identifier from an uninitialised proxy, which
     * is a subtlety this project has already been bitten by once (a rotated refresh token
     * returned a lazy User and threw LazyInitializationException). Asking the database for the
     * id directly has no such edge.
     *
     * A post that its author deleted (V49: hidden as ARCHIVED, {@code deleted_at} set) is not found here either, so its author no longer
     * owns it; an ADMIN still manages it. The method keeps its name: a frozen ArchUnit line names it.
     *
     * Empty means the post does not exist, which the caller must treat as "not the owner" —
     * never as permitted.
     */
    @Query("select p.author.id from Post p where p.id = :postId and p.deletedAt is null")
    Optional<UUID> findAuthorIdById(UUID postId);

    /** Comments on a post, whatever their status: written to the log line of a deletion, never the comments themselves. */
    @Query(value = "select count(*) from comments where post_id = :postId", nativeQuery = true)
    long countCommentsOf(UUID postId);

    /**
     * Id of the PUBLISHED post with this slug: comments and likes exist only on posts the reader can see. Only the id,
     * without loading the post: {@code content} is the whole article, and every comment read and write goes through here.
     * Empty for an unknown slug, a draft or an unpublished post; the caller returns 404 {@code POST_NOT_FOUND}
     * for all three.
     */
    @Query("select p.id from Post p where p.slug = :slug and p.status = com.blog.post.entity.PostStatus.PUBLISHED")
    Optional<UUID> findPublishedIdBySlug(String slug);

    /**
     * Whether this post is still in this status, re-read by id: a write checked the post by slug at the start of the
     * transaction, then needs to know whether the post changed status in the meantime (PostLikeService.like). Loads no post.
     */
    boolean existsByIdAndStatus(UUID id, PostStatus status);

    /**
     * Of these ids, the posts that search may still return (fail closed): published and with an ACTIVE author. One
     * statement for a whole batch of Meilisearch results; a post just unpublished, just deleted or by a person just
     * suspended is absent even if the index has not caught up yet. The order is undefined: the caller keeps the
     * engine's order.
     */
    @Query("""
            select p from Post p
            where p.id in :ids and p.status = com.blog.post.entity.PostStatus.PUBLISHED
              and p.author.status = com.blog.user.entity.UserStatus.ACTIVE""")
    List<Post> findSearchableByIdIn(Collection<UUID> ids);

    // --- Slug history ------------------------------------------------------------------------------------
    //
    // The post_slug_history table has no entity: only the statements below touch it. The two write statements are
    // @Modifying WITHOUT clearAutomatically: PostService.update calls them in the middle of a post edit, and the post
    // being edited must stay in the persistence context (managed) so that the flush at commit carries the new slug. No
    // flushAutomatically is needed: the rows here only point at the post's id, which is already in the DB, so the order
    // between them and the post's UPDATE statement does not matter.

    /** Whether this slug is the old slug of any post: a new post may not take it. */
    @Query(value = "select exists (select 1 from post_slug_history where old_slug = :slug)", nativeQuery = true)
    boolean existsInSlugHistory(String slug);

    /** Whether this slug is the old slug of ANOTHER post: the post being edited may take back its own old slug. */
    @Query(value = """
            select exists (select 1 from post_slug_history where old_slug = :slug and post_id <> :postId)""", nativeQuery = true)
    boolean existsInSlugHistoryOfOtherPost(String slug, UUID postId);

    /**
     * Records a post's old slug. 0 when the slug already has a row (this post's own, from an earlier rename, or, only with
     * hand-written data or two overlapping edits, another post's): a row is never moved to another post, because the
     * link of an old slug would then open a different article. The caller tells the two cases apart with
     * {@link #existsInSlugHistoryOfOtherPost}.
     */
    @Modifying
    @Query(value = """
            insert into post_slug_history (old_slug, post_id) values (:oldSlug, :postId)
            on conflict (old_slug) do nothing""", nativeQuery = true)
    int recordOldSlug(String oldSlug, UUID postId);

    /**
     * Keeps the {@code keep} newest old slugs of a post and drops the older ones: the post of an AUTHOR cannot reserve more
     * than a few addresses by renaming again and again.
     */
    @Modifying
    @Query(value = """
            delete from post_slug_history where post_id = :postId and old_slug not in (
                select old_slug from post_slug_history where post_id = :postId
                order by created_at desc, old_slug desc limit :keep)""", nativeQuery = true)
    int trimSlugHistory(UUID postId, int keep);

    /** Releases one old slug (the ADMIN action): the link stops working and any post may take the slug. 0 when it has no row. */
    @Modifying
    @Query(value = "delete from post_slug_history where old_slug = :slug", nativeQuery = true)
    int releaseOldSlug(String slug);

    /**
     * Drops the row of an old slug when that same post takes the slug back: the slug lives again, no
     * loop. 0 when there is no row.
     */
    @Modifying
    @Query(value = "delete from post_slug_history where old_slug = :slug and post_id = :postId", nativeQuery = true)
    int forgetOldSlug(String slug, UUID postId);

    /**
     * The current slug of the PUBLISHED post that once held this slug. One hop however many times the post changed
     * slug: the row points at the post, not at the next slug. Empty for an unknown slug, when the post is a draft,
     * unpublished or archived (the slug of a post the reader cannot see is not revealed), and when the current slug equals
     * the requested slug (a page is never redirected to itself).
     */
    @Query(value = """
            select p.slug from post_slug_history h
            join posts p on p.id = h.post_id
            where h.old_slug = :slug and p.status = 'PUBLISHED' and p.slug <> :slug""", nativeQuery = true)
    Optional<String> findPublishedSlugByOldSlug(String slug);

    /**
     * The post with a write lock on its row, held until the transaction ends. Every cover operation reads the current
     * cover through here before writing: two overlapping replacements (repeated click, two tabs) that both read the old
     * cover A would both delete A, and the image of the earlier write would become an orphan nothing points at, while
     * its public URL is still served. With the lock, the later one waits for the earlier to commit, then reads exactly
     * the image it must delete.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select p from Post p where p.id = :postId")
    Optional<Post> findByIdForUpdate(UUID postId);

    /**
     * Attaches (or detaches, with null) the cover. A dedicated SQL statement because the column is read-only on the
     * entity (see Post); leaves {@code updated_at} alone. Flushes first so the image just saved is already in the media
     * table when the foreign key is checked; clears afterwards so the reloaded entity carries the new cover instead of
     * the old copy in the persistence context. 0 means there is no such post.
     */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = "update posts set cover_media_id = :mediaId where id = :postId", nativeQuery = true)
    int setCover(UUID postId, UUID mediaId);

    /**
     * Removes every post from a series: the first step of "replace all members" and of deleting a series. The columns go
     * to NULL together, because the CHECK {@code chk_posts_series_membership} requires series and position to be a pair
     * and {@code chk_posts_series_part} wants a part to have a series. The declared part goes with the post: a caller that
     * keeps the parts of the posts that stay reads them first (see {@link #findSeriesMembers}) and writes them back with
     * {@link #assignToSeriesAtPart}. A dedicated SQL statement because the column is read-only on the entity (see Post),
     * so it leaves {@code updated_at} alone: ordering a series is an editorial act, not a post edit.
     */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(
            value = "update posts set series_id = null, series_position = null, series_part = null"
                    + " where series_id = :seriesId",
            nativeQuery = true)
    int clearSeries(UUID seriesId);

    /**
     * Puts a post into a series at a position, without a declared part; a post in another series moves over (the old
     * series is left with a gap, harmless: "Part n/m" is recounted at read time) and leaves its part behind. 0 means there
     * is no such post.
     */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(
            value = "update posts set series_id = :seriesId, series_position = :position, series_part = null"
                    + " where id = :postId",
            nativeQuery = true)
    int assignToSeries(UUID postId, UUID seriesId, int position);

    /** {@link #assignToSeries} with the part the author declared; a null part is no declared part. */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(
            value = "update posts set series_id = :seriesId, series_position = :position,"
                    + " series_part = cast(:part as integer) where id = :postId",
            nativeQuery = true)
    int assignToSeriesAtPart(UUID postId, UUID seriesId, int position, Integer part);

    /**
     * Moves every position of a series up by {@code offset}, keeping series and parts. The first step of a renumbering that
     * must not lose the declared parts: with an offset past the highest old and new position, nothing collides on
     * {@code uq_posts_series_position} (checked at each row) while the new positions are written one by one.
     */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(
            value = "update posts set series_position = series_position + :offset where series_id = :seriesId",
            nativeQuery = true)
    int shiftSeriesPositions(UUID seriesId, int offset);

    /** Sets the position of a member of a series; series and part stay. */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = "update posts set series_position = :position where id = :postId", nativeQuery = true)
    int setSeriesPosition(UUID postId, int position);

    /** Every post of a series, any status, with its language and declared part, by position. */
    @Query(value = """
            select p.id as "id", p.language as "language", p.series_position as "position", p.series_part as "part"
            from posts p
            where p.series_id = :seriesId
            order by p.series_position""", nativeQuery = true)
    List<SeriesMemberRow> findSeriesMembers(UUID seriesId);

    /** The language of a post, empty when there is no such post: the one fact placing a post in a series needs. */
    @Query("select p.language from Post p where p.id = :postId")
    Optional<String> findLanguageById(UUID postId);

    /** The posts that hold a declared part in a series and language: none, or the one the unique index allows. */
    @Query(
            value = "select id from posts where series_id = :seriesId and language = :language"
                    + " and series_part = :part",
            nativeQuery = true)
    List<UUID> findSeriesPartHolders(UUID seriesId, String language, int part);

    /**
     * Clears every "Featured posts" rank: the first step of "replace the whole order". {@code featured} is kept: an
     * ordering command never unfeatures any post. Clears everything first and only then assigns 1..n, so a new rank
     * never collides with an old one on the unique constraint {@code uq_posts_featured_rank} (checked immediately, per
     * statement). A dedicated SQL statement because the column is read-only on the entity (see Post), so it leaves
     * {@code updated_at} alone: ordering is an editorial act, not a post edit.
     */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = "update posts set featured_rank = null where featured_rank is not null", nativeQuery = true)
    int clearFeaturedRanks();

    /** Advisory lock key of the "Featured posts" ordering command: the 64 bits of the ASCII string "featured". */
    long FEATURED_ORDER_LOCK_KEY = 0x6665617475726564L;

    /**
     * Postgres advisory lock for "replace the whole order", held until the transaction ends. There is no row to lock
     * instead: the ranks span every post. Without the lock, the rank-clearing statement of the later save picks its rows
     * from a snapshot taken BEFORE the other save commits, so it misses the ranks the other just assigned; the later one
     * then gets a 409 from {@code uq_posts_featured_rank} or leaves a rank on a post it does not mention. With the lock
     * the later one waits, then wins completely, like reordering a gallery. Must be called before
     * {@link #clearFeaturedRanks}: that statement needs a snapshot taken AFTER the other save commits.
     */
    @Query(value = "select 1 from pg_advisory_xact_lock(" + FEATURED_ORDER_LOCK_KEY + ")", nativeQuery = true)
    int lockFeaturedOrder();

    /**
     * Features a post at a rank. Both columns in one statement, because the CHECK {@code chk_posts_featured_rank} only
     * lets a featured post carry a rank. 0 means there is no such post.
     */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = "update posts set featured = true, featured_rank = :rank where id = :postId", nativeQuery = true)
    int rankAsFeatured(UUID postId, int rank);

    /**
     * Features or unfeatures a post. Unfeaturing also clears the rank in the same statement: the CHECK
     * {@code chk_posts_featured_rank} does not let a non-featured post keep a rank, so saving the entity with
     * {@code featured = false} (the rank is a read-only column, the entity cannot clear it) would be rejected.
     * Featuring does not touch the rank: the newly featured post stands after the ranked posts until it is ordered,
     * while a post that already has a rank keeps it. Leaves {@code updated_at} alone, like every curation change.
     * 0 means there is no such post.
     */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = """
            update posts set featured = :featured,
                             featured_rank = case when :featured then featured_rank else null end
            where id = :postId""", nativeQuery = true)
    int setFeatured(UUID postId, boolean featured);

    /**
     * Full-text search over published posts, ranked, with optional filters.
     *
     * Native because `search_vector` is a generated tsvector column that is deliberately not
     * mapped on the entity, and because `@@` and `ts_rank` have no JPQL equivalent. This is
     * the only statement in the codebase that reads that column.
     *
     * `plainto_tsquery` rather than `to_tsquery`: it takes a user's raw words and ANDs them,
     * so a reader typing `spring boot` gets posts containing both and a reader typing
     * punctuation gets no syntax error. `to_tsquery` would make the query string an operator
     * expression a reader can get wrong.
     *
     * The {@code vi_unaccent} configuration, exactly the configuration of the {@code search_vector} column: the query
     * must be unaccented exactly like the text, so an unaccented query still matches the accented words. {@code TS_QUERY}
     * below must use the same configuration as the column: with a different one, an accented query would never match the
     * unaccented text.
     *
     * The statement is built from exactly the conditions present: no "ignore if the parameter is null" clause hides the
     * index from the planner, and there is never an empty IN. Every value is a bind parameter; the page statement and
     * the count statement share one WHERE.
     *
     * @param text     the sanitised {@code q}, null means no text search; with text, ordered by rank, otherwise newest
     *                 first
     * @param category category slug, null means no filter; the same for {@code series}
     * @param tags     distinct tag slugs, empty means no filter; a post must carry every tag
     * @param language an enabled locale, null means every language
     */
    record Search(String text, String category, String series, List<String> tags, String language) {

        private static final String TS_QUERY = "plainto_tsquery('vi_unaccent', :q)";

        public Search {
            tags = tags == null ? List.of() : List.copyOf(tags);
        }

        /** Every language. */
        public Search(String text, String category, String series, List<String> tags) {
            this(text, category, series, tags, null);
        }

        /**
         * The caller only sets the offset and page size. The final {@code id} keeps pages from repeating or
         * skipping posts.
         */
        public String sql() {
            String order = text == null
                    ? "p.published_at desc, p.id desc"
                    : "ts_rank(p.search_vector, " + TS_QUERY + ") desc, p.published_at desc, p.id desc";
            return "select " + PostCard.COLUMNS + " from posts p" + where() + " order by " + order;
        }

        public String countSql() {
            return "select count(*) from posts p" + where();
        }

        /** Only the parameters the statement has: Hibernate rejects a parameter that is not in the statement. */
        public jakarta.persistence.Query bind(jakarta.persistence.Query query) {
            if (text != null) {
                query.setParameter("q", text);
            }
            if (category != null) {
                query.setParameter("category", category);
            }
            if (series != null) {
                query.setParameter("series", series);
            }
            if (language != null) {
                query.setParameter("language", language);
            }
            if (!tags.isEmpty()) {
                query.setParameter("tags", tags);
                query.setParameter("tagCount", tags.size());
            }
            return query;
        }

        private String where() {
            // Search skips posts by a suspended author (the /posts list still lists them). author_id is NOT NULL and
            // has
            // a foreign key, so no "authorless" post is silently dropped by this statement.
            StringBuilder where = new StringBuilder(" where p.status = 'PUBLISHED'"
                    + " and exists (select 1 from users u where u.id = p.author_id and u.status = 'ACTIVE')");
            if (text != null) {
                where.append(" and p.search_vector @@ ").append(TS_QUERY);
            }
            if (language != null) {
                where.append(" and p.language = :language");
            }
            if (category != null) {
                where.append(" and p.category_id = (select c.id from categories c where c.slug = :category)");
            }
            if (series != null) {
                where.append(" and p.series_id = (select s.id from series s where s.slug = :series)");
            }
            if (!tags.isEmpty()) {
                // Counting rows counts tags: (post_id, tag_id) is the primary key, tag slugs are unique and
                // the list is deduplicated.
                where.append(" and p.id in (select pt.post_id from post_tags pt join tags t on t.id = pt.tag_id"
                        + " where t.slug in (:tags) group by pt.post_id having count(*) = :tagCount)");
            }
            return where.toString();
        }
    }

    // --- Translation groups ------------------------------------------------------------------------------
    //
    // translation_group_id is read-only on the entity, so every write is a statement here. Like the cover, each one
    // flushes first and clears the persistence context after, so a post reloaded afterwards carries the new group.

    /** The group of a post, null when it has none or the post does not exist. */
    @Query(value = "select translation_group_id from posts where id = :postId", nativeQuery = true)
    UUID findTranslationGroupId(UUID postId);

    /** Every member of a group, any status; the caller decides which ones a reader may see. */
    @Query("select p from Post p where p.translationGroupId = :groupId order by p.language")
    List<Post> findByTranslationGroupId(UUID groupId);

    /** Row locks on every member of a group, in id order (the order every group write locks in), held until commit. */
    @Query(
            value = "select id from posts where translation_group_id = :groupId order by id for update",
            nativeQuery = true)
    List<UUID> lockTranslationGroup(UUID groupId);

    /** Advisory lock key of every write to translation groups: the 64 bits of the ASCII string "xlatgrps". */
    long TRANSLATION_LOCK_KEY = 0x786c617467727073L;

    /**
     * Serialises every write to translation groups (create, link, unlink, delete of a linked post, language change) until the
     * transaction ends. These writes are rare admin actions, so one lock is cheaper than reasoning about row-lock order: it also
     * covers a post that joins a group between a read and a row lock. Must be the FIRST lock a group-writing transaction takes.
     */
    @Query(value = "select 1 from pg_advisory_xact_lock(" + TRANSLATION_LOCK_KEY + ")", nativeQuery = true)
    int lockTranslationWrites();

    /** Row lock on a series, the one every membership write takes (SeriesService.setPosts, placeByPart). */
    @Query(value = "select id from series where id = :seriesId for update", nativeQuery = true)
    List<UUID> lockSeries(UUID seriesId);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = "update posts set translation_group_id = :groupId where id = :postId", nativeQuery = true)
    int setTranslationGroup(UUID postId, UUID groupId);

    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = "update posts set translation_group_id = null where id = :postId", nativeQuery = true)
    int clearTranslationGroup(UUID postId);

    /** A group with a single member links nothing: clears that member's group. 0 when the group has two or more. */
    @Modifying(clearAutomatically = true, flushAutomatically = true)
    @Query(value = """
            update posts set translation_group_id = null
            where translation_group_id = :groupId
              and (select count(*) from posts where translation_group_id = :groupId) = 1""", nativeQuery = true)
    int dissolveSingleMemberGroup(UUID groupId);

    /** The next free position of a series, 1 for an empty one. */
    @Query(
            value = "select coalesce(max(series_position), 0) + 1 from posts where series_id = :seriesId",
            nativeQuery = true)
    int nextSeriesPosition(UUID seriesId);

    /**
     * The published posts of these translation groups, every language, one query for a whole page (the {@code translations}
     * of a post response). Drafts, unpublished and archived posts are never selected: this is the only source of
     * {@code translations} in a post response. The caller drops the post itself.
     */
    @Query(value = """
            select p.translation_group_id as "groupId", p.id as "postId", p.language as "language", p.slug as "slug",
                   p.title as "title"
            from posts p
            where p.translation_group_id in (:groupIds) and p.status = 'PUBLISHED'
            order by p.language""", nativeQuery = true)
    List<TranslationRow> findPublishedTranslations(Collection<UUID> groupIds);

    /**
     * "Part n/m" of every PUBLISHED post in the given series, one query for a whole page of posts.
     *
     * n is the post's rank among the published parts of the series in reading order, m is the number of published parts.
     * Recounted at read time instead of reading {@code series_position} directly: the position has gaps (unpublished
     * parts, removed parts), and the reader must see "Part 2/2", not "Part 3/2". {@code published_at} and {@code id}
     * only make the order deterministic; the unique constraint (series_id, series_position) already stops two parts
     * sharing a position.
     *
     * The count is per language: a series with parts in two languages numbers each language on its own ("Part 2/3" of the
     * English parts), so a reader of one language never sees the other language's parts counted.
     *
     * Native because window functions are not in JPQL. An unpublished post has no row. The caller does not call it
     * with an empty set: with no series on the page there is nothing to count.
     */
    @Query(value = """
            select p.id as "postId",
                   cast(row_number() over (partition by p.series_id, p.language
                                           order by p.series_position, p.published_at, p.id) as int) as "partNumber",
                   cast(count(*) over (partition by p.series_id, p.language) as int) as "partCount"
            from posts p
            where p.status = 'PUBLISHED'
              and p.series_id in (:seriesIds)
            """, nativeQuery = true)
    List<PartNumberRow> findPartNumbers(Collection<UUID> seriesIds);
}
