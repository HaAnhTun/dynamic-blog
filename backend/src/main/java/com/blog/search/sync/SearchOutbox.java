package com.blog.search.sync;

import com.blog.search.config.SearchProperties;
import com.blog.search.index.DocType;
import java.time.Clock;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Writes the search outbox (V33) in the SAME transaction as the change (MANDATORY), never calling Meilisearch; repeated
 * writes are merged. Only writes when {@code app.search.meili.url} has a value, whatever the query engine is (falling back
 * to Postgres still keeps the new index). The fan-out statement is one {@code INSERT … SELECT} on this transaction's DB:
 * call it before a delete or a move of the post; published posts only.
 */
@Component
@Transactional(propagation = Propagation.MANDATORY)
public class SearchOutbox {

    /**
     * {@code DISTINCT} is required: ON CONFLICT DO UPDATE must not touch a row twice in one statement. {@code ORDER BY}:
     * two transactions merging into the same documents lock rows in the same order, so they never wait on each other in a cycle (deadlock).
     */
    private static final String ENQUEUE = """
            INSERT INTO search_outbox (doc_type, source_id, state, attempts, next_attempt_at, created_at, updated_at)
            SELECT d.doc_type, d.source_id, 'PENDING', 0, ?, ?, ?
            FROM (SELECT DISTINCT s.doc_type, s.source_id FROM (%s) AS s (doc_type, source_id)) AS d
            ORDER BY d.doc_type, d.source_id
            ON CONFLICT (doc_type, source_id) WHERE state IN ('PENDING', 'FAILED') DO UPDATE SET
                state           = 'PENDING',
                attempts        = CASE WHEN search_outbox.state = 'FAILED' THEN 0 ELSE search_outbox.attempts END,
                next_attempt_at = CASE WHEN search_outbox.state = 'FAILED' THEN EXCLUDED.next_attempt_at
                                       ELSE search_outbox.next_attempt_at END,
                last_error_code = CASE WHEN search_outbox.state = 'FAILED' THEN NULL
                                       ELSE search_outbox.last_error_code END,
                updated_at      = EXCLUDED.updated_at""";

    private static final String REFS = "SELECT CAST(? AS text), unnest(CAST(? AS text[]))";
    /** The post with its category, series, author and tags: the documents whose visibility the post decides. */
    private static final String POST_AND_RELATED = """
            SELECT v.doc_type, v.source_id FROM posts p
            CROSS JOIN LATERAL (VALUES ('post', p.id::text), ('category', p.category_id::text),
                    ('series', p.series_id::text), ('author', p.author_id::text)) AS v (doc_type, source_id)
            WHERE p.id = ? AND v.source_id IS NOT NULL
            UNION ALL
            SELECT 'tag', pt.tag_id::text FROM post_tags pt WHERE pt.post_id = ?""";

    private static final String PUBLISHED_IN_CATEGORY =
            "SELECT 'post', p.id::text FROM posts p WHERE p.category_id = ? AND p.status = 'PUBLISHED'";
    private static final String PUBLISHED_WITH_TAG = """
            SELECT 'post', p.id::text FROM post_tags pt JOIN posts p ON p.id = pt.post_id
            WHERE pt.tag_id = ? AND p.status = 'PUBLISHED'""";
    private static final String PUBLISHED_IN_SERIES =
            "SELECT 'post', p.id::text FROM posts p WHERE p.series_id = ? AND p.status = 'PUBLISHED'";
    private static final String PUBLISHED_AND_THEIR_SERIES = """
            SELECT v.doc_type, v.source_id FROM posts p
            CROSS JOIN LATERAL (VALUES ('post', p.id::text), ('series', p.series_id::text)) AS v (doc_type, source_id)
            WHERE p.id = ANY (CAST(? AS uuid[])) AND p.status = 'PUBLISHED' AND v.source_id IS NOT NULL""";
    /** An author only has a document when they have a published post: with none there is nothing to sync. */
    private static final String AUTHOR_AND_PUBLISHED = """
            SELECT v.doc_type, v.source_id FROM posts p
            CROSS JOIN LATERAL (VALUES ('post', p.id::text), ('author', p.author_id::text)) AS v (doc_type, source_id)
            WHERE p.author_id = ? AND p.status = 'PUBLISHED'""";

    private final JdbcTemplate jdbcTemplate;
    private final boolean enabled;
    private final Clock clock;

    public SearchOutbox(JdbcTemplate jdbcTemplate, SearchProperties properties, Clock clock) {
        this.jdbcTemplate = jdbcTemplate;
        this.enabled = !properties.meili().url().isEmpty();
        this.clock = clock;
    }

    public void enqueue(DocType type, UUID id) {
        enqueue(type, List.of(id));
    }

    public void enqueue(DocType type, Collection<UUID> ids) {
        if (ids.isEmpty()) {
            return;
        }
        insert(REFS, type.value(), ids.stream().map(UUID::toString).toArray(String[]::new));
    }

    /** The post with its category, tags, series and author, read from the DB: publish, unpublish, delete (call before the delete statement). */
    public void postAndRelated(UUID postId) {
        insert(POST_AND_RELATED, postId, postId);
    }

    /** Published posts of the category (the post document carries the category name). */
    public void publishedPostsInCategory(UUID categoryId) {
        insert(PUBLISHED_IN_CATEGORY, categoryId);
    }

    public void publishedPostsWithTag(UUID tagId) {
        insert(PUBLISHED_WITH_TAG, tagId);
    }

    public void publishedPostsInSeries(UUID seriesId) {
        insert(PUBLISHED_IN_SERIES, seriesId);
    }

    /** Published posts in {@code postIds} and their CURRENT series: call before moving posts to another series. */
    public void publishedPostsAndTheirSeries(Collection<UUID> postIds) {
        if (postIds.isEmpty()) {
            return;
        }
        insert(PUBLISHED_AND_THEIR_SERIES, (Object)
                postIds.stream().map(UUID::toString).toArray(String[]::new));
    }

    /** An author and their published posts (the post document carries the name and profile slug; locking the account hides both). */
    public void authorAndPublishedPosts(UUID userId) {
        insert(AUTHOR_AND_PUBLISHED, userId);
    }

    private void insert(String select, Object... args) {
        if (!enabled) {
            return;
        }
        OffsetDateTime now = OffsetDateTime.ofInstant(clock.instant(), ZoneOffset.UTC);
        Object[] all = new Object[args.length + 3];
        all[0] = now;
        all[1] = now;
        all[2] = now;
        System.arraycopy(args, 0, all, 3, args.length);
        jdbcTemplate.update(ENQUEUE.formatted(select), all);
    }
}
