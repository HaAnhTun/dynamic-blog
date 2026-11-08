package com.blog.post.controller;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.response.ApiResponse;
import com.blog.post.dto.AdminPostTranslationResponse;
import com.blog.post.dto.PostResponse;
import com.blog.post.dto.PostTranslationCreateRequest;
import com.blog.post.service.PostTranslationService;
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
 * The translations of one post: list, create a draft in another language, link to an existing post, unlink. The rule on
 * {@code {id}} is the one of every post route ({@code CAN_MANAGE}); linking also needs the other post, so an AUTHOR can
 * only link two posts they own, while an ADMIN can link posts of two authors.
 */
@RestController
@RequestMapping("/api/v1/admin/posts/{id}/translations")
@RequiredArgsConstructor
public class AdminPostTranslationController {

    private final PostTranslationService translationService;

    @GetMapping
    @PreAuthorize(AdminPostController.CAN_MANAGE)
    public ApiResponse<List<AdminPostTranslationResponse>> list(@PathVariable UUID id) {
        return ApiResponse.of(
                translationService.list(id, AuthenticatedUser.requireUserId(), AuthenticatedUser.hasRole("ADMIN")));
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @PreAuthorize(AdminPostController.CAN_MANAGE)
    public ApiResponse<PostResponse> create(
            @PathVariable UUID id, @Valid @RequestBody PostTranslationCreateRequest request) {
        return ApiResponse.of(translationService.createDraft(
                id, request, AuthenticatedUser.requireUserId(), AuthenticatedUser.hasRole("ADMIN")));
    }

    @PutMapping("/{otherId}")
    @PreAuthorize("hasRole('ADMIN') or (@postAccess.isOwner(#id) and @postAccess.isOwner(#otherId))")
    public ApiResponse<PostResponse> link(@PathVariable UUID id, @PathVariable UUID otherId) {
        return ApiResponse.of(translationService.link(
                id, otherId, AuthenticatedUser.requireUserId(), AuthenticatedUser.hasRole("ADMIN")));
    }

    @DeleteMapping
    @ResponseStatus(HttpStatus.NO_CONTENT)
    @PreAuthorize(AdminPostController.CAN_MANAGE)
    public void unlink(@PathVariable UUID id) {
        translationService.unlink(id, AuthenticatedUser.requireUserId(), AuthenticatedUser.hasRole("ADMIN"));
    }
}
