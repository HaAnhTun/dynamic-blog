package com.blog.bookmark.service;

import com.blog.bookmark.dto.BookmarkResponse;
import com.blog.bookmark.entity.PostBookmarkId;
import com.blog.bookmark.repository.PostBookmarkRepository;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.post.dto.PostSummaryResponse;
import com.blog.post.entity.PostCard;
import com.blog.post.repository.PostCardRepository;
import com.blog.post.repository.PostRepository;
import com.blog.post.service.PostService;
import com.blog.user.service.CurrentUserService;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageImpl;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Posts bookmarked by the signed-in user. Every operation calls {@link CurrentUserService#requireActive()} first,
 * even read-only ones (private data, like the notification inbox); save and unsave then hit the rate limit; then
 * the post lookup.
 */
@Service
@RequiredArgsConstructor
public class BookmarkService {

    private static final int MAX_PAGE_SIZE = 50;
    /** As in PostService: larger pages are clamped so the start offset (page x size) still fits an int. */
    private static final int MAX_PAGE = Integer.MAX_VALUE / MAX_PAGE_SIZE;

    private final PostBookmarkRepository bookmarkRepository;
    private final PostRepository postRepository;
    private final PostCardRepository postCardRepository;
    private final PostService postService;
    private final CurrentUserService currentUserService;
    private final RateLimiter rateLimiter;

    /** One page of bookmarked posts that are still published, most recently saved first, as the public list DTO. */
    @Transactional(readOnly = true)
    public Page<PostSummaryResponse> list(int page, int size) {
        UUID userId = currentUserService.requireActive();
        Pageable pageable = PageRequest.of(Math.clamp(page, 0, MAX_PAGE), Math.clamp(size, 1, MAX_PAGE_SIZE));
        Page<UUID> saved = bookmarkRepository.findPublishedPostIds(userId, pageable);
        List<UUID> ids = saved.getContent();
        List<PostCard> posts = new ArrayList<>(postCardRepository.findAllById(ids));
        posts.sort(Comparator.comparingInt(post -> ids.indexOf(post.getId())));
        return new PageImpl<>(postService.toSummaries(posts), pageable, saved.getTotalElements());
    }

    @Transactional(readOnly = true)
    public BookmarkResponse get(String slug) {
        UUID userId = currentUserService.requireActive();
        UUID postId = publishedPostId(slug);
        return new BookmarkResponse(bookmarkRepository.existsById(new PostBookmarkId(userId, postId)));
    }

    @Transactional
    public BookmarkResponse save(String slug) {
        UUID userId = currentUserService.requireActive();
        rateLimiter.check(RateLimiter.BOOKMARK, userId);
        UUID postId = publishedPostId(slug);
        // 0 rows: already saved earlier, or the post was just unpublished or deleted after the lookup above. Read
        // again so we never report a bookmark that does not exist.
        boolean bookmarked = bookmarkRepository.saveIfPublished(userId, postId) == 1
                || bookmarkRepository.existsById(new PostBookmarkId(userId, postId));
        return new BookmarkResponse(bookmarked);
    }

    @Transactional
    public BookmarkResponse remove(String slug) {
        UUID userId = currentUserService.requireActive();
        rateLimiter.check(RateLimiter.BOOKMARK, userId);
        UUID postId = bookmarkRepository.findRemovablePostId(userId, slug).orElseThrow(() -> postNotFound(slug));
        bookmarkRepository.remove(userId, postId);
        return new BookmarkResponse(false);
    }

    private UUID publishedPostId(String slug) {
        return postRepository.findPublishedIdBySlug(slug).orElseThrow(() -> postNotFound(slug));
    }

    private static ApiException postNotFound(String slug) {
        return new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + slug);
    }
}
