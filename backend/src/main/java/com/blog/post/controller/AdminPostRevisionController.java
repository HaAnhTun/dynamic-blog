package com.blog.post.controller;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.response.ApiResponse;
import com.blog.post.dto.PostResponse;
import com.blog.post.dto.PostRevisionResponse;
import com.blog.post.dto.PostRevisionSummaryResponse;
import com.blog.post.service.PostRevisionService;
import com.blog.post.service.PostService;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Revisions of a post: view the history, view one revision, restore. A revision is written automatically when the post
 * is edited (PUT), so there is no path to create, edit or delete one. The same rule as every route that names a post
 * ({@link AdminPostController#CAN_MANAGE}): the history of a draft is the text of that draft.
 */
@RestController
@RequestMapping("/api/v1/admin/posts/{id}/revisions")
@RequiredArgsConstructor
public class AdminPostRevisionController {

    private final PostRevisionService postRevisionService;
    private final PostService postService;

    /** Newest first, at most 20, without content. */
    @GetMapping
    @PreAuthorize(AdminPostController.CAN_MANAGE)
    public ApiResponse<List<PostRevisionSummaryResponse>> list(@PathVariable UUID id) {
        return ApiResponse.of(postRevisionService.list(id));
    }

    @GetMapping("/{revisionId}")
    @PreAuthorize(AdminPostController.CAN_MANAGE)
    public ApiResponse<PostRevisionResponse> get(@PathVariable UUID id, @PathVariable UUID revisionId) {
        return ApiResponse.of(postRevisionService.get(id, revisionId));
    }

    /**
     * Records the current text as a revision (so it can be undone), then puts this revision's text into
     * the post; returns the post.
     */
    @PostMapping("/{revisionId}/restore")
    @PreAuthorize(AdminPostController.CAN_MANAGE)
    public ApiResponse<PostResponse> restore(@PathVariable UUID id, @PathVariable UUID revisionId) {
        return ApiResponse.of(postService.restoreRevision(id, revisionId, AuthenticatedUser.requireUserId()));
    }
}
