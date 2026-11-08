package com.blog.like.service;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.like.dto.LikeResponse;
import com.blog.like.entity.PostLikeId;
import com.blog.like.repository.PostLikeRepository;
import com.blog.notification.service.NotificationWriter;
import com.blog.post.entity.PostStatus;
import com.blog.post.repository.PostRepository;
import com.blog.user.service.CurrentUserService;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Post likes. Only published posts; one like per user per post; liking and unliking are both idempotent and return
 * the server's state, not what the caller guesses.
 *
 * Writes follow the same order as every reader write: {@link CurrentUserService#requireActive()} first (a suspended
 * user is blocked even while the token is valid), then the rate limit, then the post. Reads check nothing beyond
 * the post: anonymous or suspended users still see the count.
 *
 * The count is not part of PostSummary or PostResponse, and there is no counter column on posts (V20): the cached
 * data of the post page contains nothing reader-specific, so no tag needs refreshing.
 *
 * A like that was actually just inserted notifies the post's author (NotificationWriter), in the same
 * transaction; liking an already liked post does not.
 */
@Service
@RequiredArgsConstructor
public class PostLikeService {

    private final PostLikeRepository postLikeRepository;
    private final PostRepository postRepository;
    private final CurrentUserService currentUserService;
    private final RateLimiter rateLimiter;
    private final NotificationWriter notificationWriter;

    /**
     * @return the caller's {@code liked} (false when anonymous) and the like count
     * @throws ApiException 404 {@code POST_NOT_FOUND} when the post does not exist, is a draft or unpublished: its count is not revealed
     */
    @Transactional(readOnly = true)
    public LikeResponse get(String slug) {
        UUID postId = publishedPostId(slug);
        boolean liked = AuthenticatedUser.currentUserId()
                .map(userId -> postLikeRepository.existsById(new PostLikeId(postId, userId)))
                .orElse(false);
        return new LikeResponse(liked, postLikeRepository.countByPostId(postId));
    }

    /**
     * Likes. If already liked, does nothing and still returns 200. Returns {@code liked} as read from the DB, never
     * reporting a like that does not exist.
     *
     * @throws ApiException 401 or 403 {@code USER_SUSPENDED} (requireActive); 429 {@code RATE_LIMITED}; 404
     *                      {@code POST_NOT_FOUND}, including when the post is unpublished right between the check
     *                      and the write
     */
    @Transactional
    public LikeResponse like(String slug) {
        UUID userId = currentUserService.requireActive();
        rateLimiter.check(RateLimiter.LIKE, userId);
        UUID postId = publishedPostId(slug);
        PostLikeId id = new PostLikeId(postId, userId);
        if (postLikeRepository.likeIfPublished(postId, userId) == 1) {
            notificationWriter.postLiked(userId, postId);
        } else if (!postLikeRepository.existsById(id)) {
            // Could not insert, and reading back finds no like either. Two reasons, told apart by the post status:
            // - the post was unpublished after the check above, so the INSERT can no longer select the post: 404,
            //   because returning "liked" here would report a like that does not exist;
            // - the INSERT hit this same user's old like (ON CONFLICT DO NOTHING skips without locking that row), and
            //   then an unlike from another tab committed before the read-back: the post is still published, so like
            //   once more, as if this like arrived after that unlike, and return what the DB actually holds. That
            //   re-insert is also a new like, so it notifies too (this user's old notification for this post, if
            //   still there, is left as is).
            if (!postRepository.existsByIdAndStatus(postId, PostStatus.PUBLISHED)) {
                throw postNotFound(slug);
            }
            boolean inserted = postLikeRepository.likeIfPublished(postId, userId) == 1;
            if (inserted) {
                notificationWriter.postLiked(userId, postId);
            }
            boolean liked = inserted || postLikeRepository.existsById(id);
            return new LikeResponse(liked, postLikeRepository.countByPostId(postId));
        }
        // Just inserted, or already liked before (liking again does not notify a second time).
        return new LikeResponse(true, postLikeRepository.countByPostId(postId));
    }

    /**
     * Unlikes. If not liked, does nothing and still returns 200.
     *
     * @throws ApiException as {@link #like}
     */
    @Transactional
    public LikeResponse unlike(String slug) {
        UUID userId = currentUserService.requireActive();
        rateLimiter.check(RateLimiter.LIKE, userId);
        UUID postId = publishedPostId(slug);
        postLikeRepository.unlike(postId, userId);
        return new LikeResponse(false, postLikeRepository.countByPostId(postId));
    }

    private UUID publishedPostId(String slug) {
        return postRepository.findPublishedIdBySlug(slug).orElseThrow(() -> postNotFound(slug));
    }

    private static ApiException postNotFound(String slug) {
        return new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + slug);
    }
}
