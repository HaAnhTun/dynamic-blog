package com.blog.author.controller;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.author.dto.AuthorApplicationAdminResponse;
import com.blog.author.dto.AuthorApplicationApproveRequest;
import com.blog.author.entity.AuthorApplicationStatus;
import com.blog.author.service.AuthorApplicationService;
import com.blog.common.response.ApiResponse;
import com.blog.common.response.PageMeta;
import com.blog.common.response.PagedResponse;
import jakarta.validation.Valid;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Reviews author applications. ADMIN only, enforced by the URL rule {@code /api/v1/admin/author-applications/**} in
 * SecurityConfig. The deciding user comes from the token, never from the request.
 */
@RestController
@RequestMapping("/api/v1/admin/author-applications")
@RequiredArgsConstructor
public class AdminAuthorApplicationController {

    private final AuthorApplicationService authorApplicationService;

    /** Defaults to the waiting queue ({@code PENDING}); an unknown value is a 400. */
    @GetMapping
    public PagedResponse<AuthorApplicationAdminResponse> list(
            @RequestParam(defaultValue = "PENDING") AuthorApplicationStatus status,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        Page<AuthorApplicationAdminResponse> result = authorApplicationService.list(status, page, size);
        return new PagedResponse<>(
                result.getContent(),
                new PageMeta(result.getNumber(), result.getSize(), result.getTotalElements(), result.getTotalPages()));
    }

    /**
     * Approves. Making a reader an author also needs the caller's own {@code code} in the optional body and a sign-in from the last
     * minutes (401 {@code REAUTHENTICATION_REQUIRED}, 401 {@code MFA_CODE_INVALID}...); an applicant who already has the role needs none.
     */
    @PostMapping("/{id}/approve")
    public ApiResponse<AuthorApplicationAdminResponse> approve(
            @PathVariable UUID id, @Valid @RequestBody(required = false) AuthorApplicationApproveRequest request) {
        return ApiResponse.of(authorApplicationService.approve(
                AuthenticatedUser.requireUserId(), id, request == null ? null : request.code()));
    }

    @PostMapping("/{id}/reject")
    public ApiResponse<AuthorApplicationAdminResponse> reject(@PathVariable UUID id) {
        return ApiResponse.of(authorApplicationService.reject(AuthenticatedUser.requireUserId(), id));
    }
}
