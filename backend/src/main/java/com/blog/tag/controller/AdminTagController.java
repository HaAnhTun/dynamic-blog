package com.blog.tag.controller;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.response.ApiResponse;
import com.blog.tag.dto.TagMergeRequest;
import com.blog.tag.dto.TagMergeResponse;
import com.blog.tag.dto.TagRequest;
import com.blog.tag.dto.TagResponse;
import com.blog.tag.service.TagService;
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
 * Tag administration, same permission rules as categories (AdminCategoryController): listing and creating are open to
 * AUTHOR as well, because the post editor creates tags in place; update, delete and merge touch the posts of every
 * author, so they are ADMIN only, enforced with {@code @PreAuthorize}.
 */
@RestController
@RequestMapping("/api/v1/admin/tags")
@RequiredArgsConstructor
public class AdminTagController {

    private final TagService tagService;

    @GetMapping
    public ApiResponse<List<TagResponse>> list() {
        return ApiResponse.of(tagService.list());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public ApiResponse<TagResponse> create(@Valid @RequestBody TagRequest request) {
        return ApiResponse.of(
                tagService.create(request, AuthenticatedUser.requireUserId(), AuthenticatedUser.hasRole("ADMIN")));
    }

    /** Renames; the slug is kept. */
    @PutMapping("/{id}")
    @PreAuthorize("hasRole('ADMIN')")
    public ApiResponse<TagResponse> update(@PathVariable UUID id, @Valid @RequestBody TagRequest request) {
        return ApiResponse.of(tagService.update(id, request));
    }

    /** The tag leaves every post that carries it; the posts stay intact. */
    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize("hasRole('ADMIN')")
    public void delete(@PathVariable UUID id) {
        tagService.delete(id);
    }

    /**
     * Merges tag {@code id} into tag {@code targetId}: the posts of the source tag carry the target tag, then the source
     * tag is deleted. Returns 200 with the target tag and the post count, not 204: admin-api cannot read a 204.
     */
    @PostMapping("/{id}/merge")
    @PreAuthorize("hasRole('ADMIN')")
    public ApiResponse<TagMergeResponse> merge(@PathVariable UUID id, @Valid @RequestBody TagMergeRequest request) {
        return ApiResponse.of(tagService.merge(id, request.targetId()));
    }
}
