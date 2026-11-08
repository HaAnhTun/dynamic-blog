package com.blog.post.controller;

import com.blog.post.service.PostService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Old addresses of posts. ADMIN only, like everything under {@code /api/v1/admin} that is not in an AUTHOR tree: a post that was
 * renamed keeps its old address working (a redirect), and an old address reserves the slug, so an ADMIN needs a way to release one
 * on purpose. The post and its other old addresses are not touched.
 */
@RestController
@RequestMapping("/api/v1/admin/slug-history")
@RequiredArgsConstructor
public class AdminSlugHistoryController {

    private final PostService postService;

    /** Releases the old address {@code slug}: 204, or 404 {@code SLUG_HISTORY_NOT_FOUND} when no post has it as an old address. */
    @DeleteMapping("/{slug}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void release(@PathVariable String slug) {
        postService.releaseOldSlug(slug);
    }
}
