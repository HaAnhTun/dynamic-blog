package com.blog.bookmark.controller;

import com.blog.bookmark.dto.BookmarkResponse;
import com.blog.bookmark.service.BookmarkService;
import com.blog.common.response.ApiResponse;
import com.blog.common.response.PageMeta;
import com.blog.common.response.PagedResponse;
import com.blog.post.dto.PostSummaryResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Posts bookmarked by the signed-in user. Every route requires login, any role (SecurityConfig); no route
 * accepts a user id or a body: the bookmarking user is always the token owner. Save and unsave return 200 with
 * {@code {bookmarked}}.
 */
@RestController
@RequestMapping("/api/v1/me/bookmarks")
@RequiredArgsConstructor
public class BookmarkController {

    private final BookmarkService bookmarkService;

    @GetMapping
    public PagedResponse<PostSummaryResponse> list(
            @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "20") int size) {
        Page<PostSummaryResponse> result = bookmarkService.list(page, size);
        return new PagedResponse<>(
                result.getContent(),
                new PageMeta(result.getNumber(), result.getSize(), result.getTotalElements(), result.getTotalPages()));
    }

    @GetMapping("/{slug}")
    public ApiResponse<BookmarkResponse> get(@PathVariable String slug) {
        return ApiResponse.of(bookmarkService.get(slug));
    }

    /** Save; idempotent. */
    @PutMapping("/{slug}")
    public ApiResponse<BookmarkResponse> save(@PathVariable String slug) {
        return ApiResponse.of(bookmarkService.save(slug));
    }

    /** Unsave; idempotent. */
    @DeleteMapping("/{slug}")
    public ApiResponse<BookmarkResponse> remove(@PathVariable String slug) {
        return ApiResponse.of(bookmarkService.remove(slug));
    }
}
