package com.blog.category.controller;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.category.dto.CategoryMergeRequest;
import com.blog.category.dto.CategoryMergeResponse;
import com.blog.category.dto.CategoryRequest;
import com.blog.category.dto.CategoryResponse;
import com.blog.category.service.CategoryService;
import com.blog.common.response.ApiResponse;
import jakarta.validation.Valid;
import java.util.List;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Category administration. Listing and creating are open to AUTHOR as well (the tree is in SecurityConfig's AUTHOR list): the
 * post editor creates categories in place. Update, delete and merge are ADMIN only: a category groups posts from every
 * author, so renaming, deleting or merging it is a site-level decision, not an author's. Enforced with
 * {@code @PreAuthorize} rather than a URL rule because these operations share a URL tree with two operations AUTHOR
 * may perform, such as {@code setFeaturedOrder} in AdminPostController.
 */
@RestController
@RequestMapping("/api/v1/admin/categories")
@RequiredArgsConstructor
public class AdminCategoryController {

    private final CategoryService categoryService;

    @GetMapping
    public ApiResponse<List<CategoryResponse>> list() {
        return ApiResponse.of(categoryService.list());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<CategoryResponse> create(@Valid @RequestBody CategoryRequest request) {
        return ApiResponse.of(
                categoryService.create(request, AuthenticatedUser.requireUserId(), AuthenticatedUser.hasRole("ADMIN")));
    }

    /** Replaces the whole name and description; the slug is kept. */
    @PutMapping("/{id}")
    @PreAuthorize("hasRole('ADMIN')")
    public ApiResponse<CategoryResponse> update(@PathVariable UUID id, @Valid @RequestBody CategoryRequest request) {
        return ApiResponse.of(categoryService.update(id, request));
    }

    /** Only a category no post uses any more; otherwise 409 {@code CATEGORY_IN_USE}. */
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasRole('ADMIN')")
    public void delete(@PathVariable UUID id) {
        categoryService.delete(id);
    }

    /**
     * Merges category {@code id} into category {@code targetId}: moves every post to the target, then deletes the
     * source. This is the way out for a category that still has posts, which DELETE refuses. Returns 200 with the
     * target category and the post count, not 204: admin-api cannot read a 204.
     */
    @PostMapping("/{id}/merge")
    @PreAuthorize("hasRole('ADMIN')")
    public ApiResponse<CategoryMergeResponse> merge(
            @PathVariable UUID id, @Valid @RequestBody CategoryMergeRequest request) {
        return ApiResponse.of(categoryService.merge(id, request.targetId()));
    }
}
