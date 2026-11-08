package com.blog.like.service;

import com.blog.comment.entity.CommentStatus;
import com.blog.comment.repository.CommentRepository;
import com.blog.comment.repository.CommentStateRow;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.like.dto.LikeResponse;
import com.blog.like.entity.CommentLikeId;
import com.blog.like.repository.CommentLikeRepository;
import com.blog.notification.service.NotificationWriter;
import com.blog.post.entity.PostStatus;
import com.blog.user.service.CurrentUserService;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Comment likes, with the same rules as post likes (PostLikeService): one like per user per comment; liking and
 * unliking are both idempotent and return the server's state. Only comments that are VISIBLE on a published post;
 * every other case is 404 {@code COMMENT_NOT_FOUND}, like replying and editing. Liking your own comment is allowed,
 * as with posts, and creates no notification. Shares the {@link RateLimiter#LIKE} rate limit with post likes.
 *
 * The numbers have no GET route of their own: they come with the comment ({@code likeCount}, {@code likedByMe},
 * CommentService).
 */
@Service
@RequiredArgsConstructor
public class CommentLikeService {

    private final CommentLikeRepository commentLikeRepository;
    private final CommentRepository commentRepository;
    private final NotificationWriter notificationWriter;
    private final CurrentUserService currentUserService;
    private final RateLimiter rateLimiter;

    /**
     * Likes. If already liked, does nothing and still returns 200. A like that was actually just inserted notifies
     * the comment's author (unless it is a self-like), in the same transaction.
     *
     * Locks follow the same order as a reply: the post row first (FOR KEY SHARE), then the comment. Inserting the
     * like touches the comment row (foreign key of comment_likes) and then the post row (post_id foreign key of
     * notifications), while a hard delete of a post locks the post row and only then cascades into each comment:
     * without locking the post first the two wait for each other, Postgres aborts one (40P01) and the caller gets
     * 500.
     *
     * @throws ApiException 401 or 403 {@code USER_SUSPENDED} (requireActive); 429 {@code RATE_LIMITED}; 404
     *                      {@code COMMENT_NOT_FOUND} when the comment does not exist, is no longer VISIBLE or its
     *                      post is no longer published, including when that happens right between the check and
     *                      the write
     */
    @Transactional
    public LikeResponse like(UUID commentId) {
        UUID userId = currentUserService.requireActive();
        rateLimiter.check(RateLimiter.LIKE, userId);
        if (commentRepository.lockPostOfComment(commentId).isEmpty()) {
            // No such comment, or its post was just deleted (taking the comment with it) while waiting for the lock.
            throw commentNotFound(commentId);
        }
        requirePublic(commentId);

        CommentLikeId id = new CommentLikeId(commentId, userId);
        if (commentLikeRepository.likeIfVisible(commentId, userId) == 1) {
            notificationWriter.commentLiked(userId, commentId);
        } else if (!commentLikeRepository.existsById(id)) {
            // Could not insert, and reading back finds no like either: as in PostLikeService.like, either the comment
            // was just hidden or deleted or its post unpublished after the check above (404), or an unlike from another
            // tab committed after the insert hit the old like (like again once, and notify like any new like).
            requirePublic(commentId);
            boolean inserted = commentLikeRepository.likeIfVisible(commentId, userId) == 1;
            if (inserted) {
                notificationWriter.commentLiked(userId, commentId);
            }
            boolean liked = inserted || commentLikeRepository.existsById(id);
            return new LikeResponse(liked, commentLikeRepository.countByCommentId(commentId));
        }
        // Just inserted, or already liked before (liking again does not notify a second time).
        return new LikeResponse(true, commentLikeRepository.countByCommentId(commentId));
    }

    /**
     * Unlikes. If not liked, does nothing and still returns 200. Leaves notifications alone: the notification of an
     * unliked like is only hidden at read time, and shows up again unchanged if that user likes again.
     *
     * @throws ApiException as {@link #like}
     */
    @Transactional
    public LikeResponse unlike(UUID commentId) {
        UUID userId = currentUserService.requireActive();
        rateLimiter.check(RateLimiter.LIKE, userId);
        requirePublic(commentId);
        commentLikeRepository.unlike(commentId, userId);
        return new LikeResponse(false, commentLikeRepository.countByCommentId(commentId));
    }

    /** A comment readers can still see: VISIBLE, on a published post; every other case is 404. */
    private void requirePublic(UUID commentId) {
        commentRepository
                .findState(commentId)
                .filter(CommentLikeService::isPublic)
                .orElseThrow(() -> commentNotFound(commentId));
    }

    private static boolean isPublic(CommentStateRow row) {
        return CommentStatus.VISIBLE.name().equals(row.getStatus())
                && PostStatus.PUBLISHED.name().equals(row.getPostStatus());
    }

    private static ApiException commentNotFound(UUID commentId) {
        return new ApiException(ErrorCode.COMMENT_NOT_FOUND, HttpStatus.NOT_FOUND, "Comment not found: " + commentId);
    }
}
