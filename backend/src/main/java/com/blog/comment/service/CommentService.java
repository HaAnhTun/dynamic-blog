package com.blog.comment.service;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.comment.dto.CommentPage;
import com.blog.comment.dto.CommentRequest;
import com.blog.comment.dto.CommentResponse;
import com.blog.comment.dto.CommentThreadResponse;
import com.blog.comment.entity.Comment;
import com.blog.comment.entity.CommentStatus;
import com.blog.comment.mapper.CommentLikeStats;
import com.blog.comment.mapper.CommentMapper;
import com.blog.comment.repository.CommentRepository;
import com.blog.comment.repository.CommentStateRow;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.like.repository.CommentLikeCountRow;
import com.blog.like.repository.CommentLikeRepository;
import com.blog.notification.service.NotificationWriter;
import com.blog.post.entity.PostStatus;
import com.blog.post.repository.PostRepository;
import com.blog.user.service.CurrentUserService;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Reader comments on published posts: paged reads, create, one-level replies, and the author editing and soft
 * deleting their own comments. Admin moderation is CommentModerationService's job.
 *
 * Every write follows exactly one order:
 * <ol>
 *   <li>{@link CurrentUserService#requireActive()} first: a suspended user is blocked even while the token is
 *       still valid;</li>
 *   <li>sanitize the content (400) and apply the rate limit (429), both before touching any post or comment;</li>
 *   <li>404 (missing, no longer visible, post no longer published) and only then 403 (not the author): other
 *       users cannot probe whether a hidden comment exists;</li>
 *   <li>the conditional write, where the number of rows it changes decides the outcome: an admin hide committed
 *       between the check and the write makes an edit get 404 instead of overwriting it; a post unpublish
 *       committed between the check and the insert makes a create or reply get 404 instead of adding to an
 *       unpublished post.</li>
 * </ol>
 *
 * The author is always the token owner, never taken from the request body. A comment that is no longer VISIBLE is
 * 404 for readers, even for its own author: nobody edits content to dodge moderation.
 *
 * Each comment carries its likes, and a newly added comment or reply creates a notification (NotificationWriter)
 * in the same transaction, after all the checks above: a rejected submit (400, 404, 409, 422, 429) never gets
 * there.
 */
@Service
@RequiredArgsConstructor
public class CommentService {

    static final int MAX_PAGE_SIZE = 20;
    static final int MAX_REPLIES_PER_ROOT = 30;

    private final CommentRepository commentRepository;
    private final PostRepository postRepository;
    private final CommentLikeRepository commentLikeRepository;
    private final NotificationWriter notificationWriter;
    private final CurrentUserService currentUserService;
    private final RateLimiter rateLimiter;

    /**
     * One page of root comments, oldest first, each with its visible replies. The number of queries does not grow
     * with the page size, none per thread: the post, the root ids, the roots with authors, all replies with authors,
     * the like counts of every comment on the page, and for a signed-in user one more query "which of these comments
     * did I like". It writes nothing, so there is no rate limit and no account status check: a suspended user reads
     * like an anonymous one, differing only in {@code mine} and {@code likedByMe}.
     *
     * @param after cursor of the previous page ({@link CommentPage#nextCursor()}); null or empty means the first page
     * @param size  number of root comments, clamped to 1..20
     * @throws ApiException 404 {@code POST_NOT_FOUND} when the post does not exist or is not (no longer) published;
     *                      400 {@code VALIDATION_ERROR} when the cursor is malformed
     */
    @Transactional(readOnly = true)
    public CommentPage list(String slug, String after, int size) {
        int pageSize = Math.clamp(size, 1, MAX_PAGE_SIZE);
        CommentCursor cursor = CommentCursor.decode(after);
        UUID postId = publishedPostId(slug);
        List<UUID> ids = cursor == null
                ? commentRepository.findRootIds(postId, pageSize + 1)
                : commentRepository.findRootIdsAfter(postId, cursor.createdAt(), cursor.id(), pageSize + 1);
        // The extra row only tells us a next page exists: it opens the next page and does not belong to this one.
        boolean hasMore = ids.size() > pageSize;
        List<UUID> pageIds = hasMore ? ids.subList(0, pageSize) : ids;
        if (pageIds.isEmpty()) {
            return new CommentPage(List.of(), null);
        }

        Map<UUID, Comment> roots = commentRepository.findAllWithAuthorByIdIn(pageIds).stream()
                .collect(Collectors.toMap(Comment::getId, Function.identity()));
        // groupingBy keeps encounter order within each group, i.e. the (created_at, id) order of the query.
        Map<UUID, List<Comment>> replies = commentRepository.findVisibleRepliesWithAuthor(pageIds).stream()
                .collect(Collectors.groupingBy(Comment::getParentId));
        UUID viewerId = AuthenticatedUser.currentUserId().orElse(null);
        List<UUID> shownIds = new ArrayList<>(roots.keySet());
        replies.values().forEach(thread -> thread.forEach(reply -> shownIds.add(reply.getId())));
        CommentLikeStats likes = likeStats(shownIds, viewerId);

        List<CommentThreadResponse> threads = new ArrayList<>(pageIds.size());
        Comment last = null;
        for (UUID id : pageIds) {
            Comment root = roots.get(id);
            if (root == null) {
                // Can only be a hard delete between the two queries, i.e. the post was just deleted: skip instead of
                // returning an empty thread.
                continue;
            }
            last = root;
            threads.add(new CommentThreadResponse(
                    CommentMapper.toResponse(root, viewerId, likes),
                    replies.getOrDefault(id, List.of()).stream()
                            .map(reply -> CommentMapper.toResponse(reply, viewerId, likes))
                            .toList()));
        }
        String nextCursor = hasMore && last != null ? CommentCursor.after(last).encode() : null;
        return new CommentPage(threads, nextCursor);
    }

    /**
     * A new root comment by the caller on a published post.
     *
     * @throws ApiException 401 or 403 {@code USER_SUSPENDED} (requireActive); 400 {@code VALIDATION_ERROR}; 429
     *                      {@code RATE_LIMITED}; 404 {@code POST_NOT_FOUND}, including when the post is unpublished
     *                      right between the check and the write; 409 {@code COMMENT_DUPLICATE} when this exact
     *                      content was submitted by this user to this post within the last 10 minutes
     */
    @Transactional
    public CommentResponse create(String slug, CommentRequest request) {
        UUID userId = currentUserService.requireActive();
        String content = CommentContent.normalize(request.content());
        rateLimiter.check(RateLimiter.COMMENT, userId);
        UUID postId = publishedPostId(slug);

        commentRepository.lockCreateFor(userId);
        if (commentRepository.existsRecentRootDuplicate(userId, postId, content)) {
            throw duplicate();
        }
        UUID id = UUID.randomUUID();
        if (commentRepository.insertRootIfPublished(id, postId, userId, content, now()) == 0) {
            // The post was unpublished (or archived, deleted) after the check above, possibly while waiting for the
            // per-user lock.
            throw postNotFound(slug);
        }
        // The insert just ran the post_id foreign-key check, so it already holds FOR KEY SHARE on the post row: the
        // notification only joins rows already held, so it adds no lock ordering against a hard delete of the post.
        notificationWriter.commentCreated(id);
        return inserted(id, userId);
    }

    /**
     * Replies to a root comment. One level only: replying to a reply is 422, it is not silently attached to its
     * root.
     *
     * Locks are taken in exactly one order and held until commit: the post row of the parent comment (FOR KEY
     * SHARE), then the parent comment itself (write lock), then the per-user lock of the create. Post before
     * comment is the order of a hard delete of a post (post row, then ON DELETE CASCADE into each comment); comment
     * before the per-user lock because no path takes the per-user lock and then locks a comment row. With the same
     * order on every path there is no crossed locking.
     *
     * @throws ApiException as {@link #create}, plus: 404 {@code COMMENT_NOT_FOUND} when the parent does not exist,
     *                      is no longer VISIBLE or its post is no longer published, including when the post is
     *                      unpublished right between the check and the write; 422 {@code COMMENT_NOT_REPLYABLE}
     *                      when the parent is a reply, or already has 30 replies (any status)
     */
    @Transactional
    public CommentResponse reply(UUID parentId, CommentRequest request) {
        UUID userId = currentUserService.requireActive();
        String content = CommentContent.normalize(request.content());
        rateLimiter.check(RateLimiter.COMMENT, userId);
        if (commentRepository.lockPostOfComment(parentId).isEmpty()) {
            // No such comment, or its post was just deleted (taking the comment with it) while waiting for the lock.
            throw commentNotFound(parentId);
        }
        CommentStateRow parent = commentRepository
                .findStateForUpdate(parentId)
                .filter(CommentService::isPublic)
                .orElseThrow(() -> commentNotFound(parentId));
        if (parent.getParentId() != null) {
            throw notReplyable("Replies can only be added to a top-level comment");
        }

        commentRepository.lockCreateFor(userId);
        if (commentRepository.existsRecentReplyDuplicate(userId, parentId, content)) {
            throw duplicate();
        }
        if (commentRepository.countReplies(parentId) >= MAX_REPLIES_PER_ROOT) {
            throw notReplyable("This comment already has " + MAX_REPLIES_PER_ROOT + " replies");
        }
        UUID id = UUID.randomUUID();
        if (commentRepository.insertReplyIfPublished(id, parent.getPostId(), userId, parentId, content, now()) == 0) {
            // The FOR KEY SHARE lock on the post row does not block unpublishing: the post was unpublished after the
            // parent comment check, so the parent is no longer public.
            throw commentNotFound(parentId);
        }
        // Notify the author of the parent comment, and the post author when they have not already been notified by that
        // one.
        notificationWriter.commentCreated(id);
        return inserted(id, userId);
    }

    /**
     * The author edits the content of their own comment. There is no time limit; identical content (after
     * sanitizing) does nothing and does not turn on "edited".
     *
     * @throws ApiException 401/403 {@code USER_SUSPENDED}; 400; 429; 404 {@code COMMENT_NOT_FOUND} when the comment
     *                      does not exist, is no longer VISIBLE or its post is no longer published, including when
     *                      that happens right between the check and the write; 403 {@code FORBIDDEN} when the
     *                      caller is not the author
     */
    @Transactional
    public CommentResponse edit(UUID commentId, CommentRequest request) {
        UUID userId = currentUserService.requireActive();
        String content = CommentContent.normalize(request.content());
        rateLimiter.check(RateLimiter.COMMENT_EDIT, userId);
        requireOwnAndPublic(commentId, userId);

        if (commentRepository.editOwnIfVisible(commentId, userId, content) == 0) {
            // No row changed: identical content (200, nothing to do), or the comment was just hidden or deleted, or the
            // post was just unpublished after the check above (404; the admin's status stays). Read again to tell
            // which.
            CommentStateRow current = requireOwnAndPublic(commentId, userId);
            if (!current.getContent().equals(content)) {
                throw commentNotFound(commentId);
            }
        }
        Comment comment = commentRepository.findWithAuthorById(commentId).orElseThrow(() -> commentNotFound(commentId));
        return CommentMapper.toResponse(comment, userId, likeStats(List.of(commentId), userId));
    }

    /**
     * The author soft-deletes their own comment: the content is kept for moderation; a root that still has visible
     * replies becomes a placeholder. The second delete is 404, like any comment that is no longer VISIBLE.
     *
     * @throws ApiException as {@link #edit}, except 400
     */
    @Transactional
    public void delete(UUID commentId) {
        UUID userId = currentUserService.requireActive();
        rateLimiter.check(RateLimiter.COMMENT_EDIT, userId);
        requireOwnAndPublic(commentId, userId);

        if (commentRepository.softDeleteOwnIfVisible(commentId, userId) == 0) {
            throw commentNotFound(commentId);
        }
    }

    /**
     * The comment just inserted, read back with its author. The insert ran immediately, while the per-user lock is
     * still held: the same user's next submit waits for the lock and then sees this row. Nobody has had time to like
     * it yet.
     */
    private CommentResponse inserted(UUID id, UUID userId) {
        Comment comment = commentRepository.findWithAuthorById(id).orElseThrow(() -> commentNotFound(id));
        return CommentMapper.toResponse(comment, userId, CommentLikeStats.EMPTY);
    }

    /**
     * Likes of these comments, in batch: one count query, and one "which of these did the viewer like" query when
     * there is a viewer, however many comments there are.
     *
     * @param viewerId null when anonymous: there is no second query
     */
    private CommentLikeStats likeStats(Collection<UUID> commentIds, UUID viewerId) {
        if (commentIds.isEmpty()) {
            return CommentLikeStats.EMPTY;
        }
        Map<UUID, Long> counts = commentLikeRepository.countByCommentIdIn(commentIds).stream()
                .collect(Collectors.toMap(CommentLikeCountRow::getCommentId, CommentLikeCountRow::getLikes));
        Set<UUID> liked =
                viewerId == null ? Set.of() : new HashSet<>(commentLikeRepository.likedAmong(viewerId, commentIds));
        return new CommentLikeStats(counts, liked);
    }

    /** Creation time, truncated to microseconds as Postgres stores it (see {@link CommentRepository#insertRootIfPublished}). */
    private static Instant now() {
        return Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    /** 404 first, then 403 (the check order). */
    private CommentStateRow requireOwnAndPublic(UUID commentId, UUID userId) {
        CommentStateRow row = commentRepository
                .findState(commentId)
                .filter(CommentService::isPublic)
                .orElseThrow(() -> commentNotFound(commentId));
        if (!row.getUserId().equals(userId)) {
            throw new ApiException(
                    ErrorCode.FORBIDDEN, HttpStatus.FORBIDDEN, "Only the author of a comment can change it");
        }
        return row;
    }

    /** A comment readers can still see: VISIBLE, on a published post. */
    private static boolean isPublic(CommentStateRow row) {
        return CommentStatus.VISIBLE.name().equals(row.getStatus())
                && PostStatus.PUBLISHED.name().equals(row.getPostStatus());
    }

    private UUID publishedPostId(String slug) {
        return postRepository.findPublishedIdBySlug(slug).orElseThrow(() -> postNotFound(slug));
    }

    private static ApiException postNotFound(String slug) {
        return new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + slug);
    }

    private static ApiException commentNotFound(UUID commentId) {
        return new ApiException(ErrorCode.COMMENT_NOT_FOUND, HttpStatus.NOT_FOUND, "Comment not found: " + commentId);
    }

    private static ApiException notReplyable(String message) {
        return new ApiException(ErrorCode.COMMENT_NOT_REPLYABLE, HttpStatus.UNPROCESSABLE_CONTENT, message);
    }

    private static ApiException duplicate() {
        return new ApiException(
                ErrorCode.COMMENT_DUPLICATE,
                HttpStatus.CONFLICT,
                "The same comment was posted here less than 10 minutes ago");
    }
}
