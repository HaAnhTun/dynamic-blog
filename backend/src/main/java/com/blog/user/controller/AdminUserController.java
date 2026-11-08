package com.blog.user.controller;

import com.blog.auth.dto.MeMfaCodeRequest;
import com.blog.auth.service.AccountSecurityService;
import com.blog.auth.support.AuthenticatedUser;
import com.blog.common.response.ApiResponse;
import com.blog.common.response.PageMeta;
import com.blog.common.response.PagedResponse;
import com.blog.user.dto.UserAdminResponse;
import com.blog.user.dto.UserRoleRequest;
import com.blog.user.dto.UserStatusRequest;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import com.blog.user.service.AdminUserService;
import jakarta.validation.Valid;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

/**
 * Minimal user management: list accounts, suspend and reactivate readers. ADMIN only, decided by the URL rule
 * {@code /api/v1/admin/users/**} in SecurityConfig: there is no "my users" for an AUTHOR to manage.
 */
@RestController
@RequestMapping("/api/v1/admin/users")
@RequiredArgsConstructor
public class AdminUserController {

    private final AdminUserService adminUserService;
    private final AccountSecurityService accountSecurityService;

    /** Newest first. An empty {@code role} or {@code status} means no filter; an unknown value is 400. */
    @GetMapping
    public PagedResponse<UserAdminResponse> list(
            @RequestParam(required = false) String q,
            @RequestParam(required = false) UserRole role,
            @RequestParam(required = false) UserStatus status,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "20") int size) {
        Page<UserAdminResponse> result = adminUserService.list(q, role, status, page, size);
        return new PagedResponse<>(
                result.getContent(),
                new PageMeta(result.getNumber(), result.getSize(), result.getTotalElements(), result.getTotalPages()));
    }

    /** Suspends or reactivates a reader. The caller is taken from the token, never from the request body. */
    @PatchMapping("/{id}/status")
    public ApiResponse<UserAdminResponse> setStatus(
            @PathVariable UUID id, @Valid @RequestBody UserStatusRequest request) {
        return ApiResponse.of(adminUserService.setStatus(AuthenticatedUser.requireUserId(), id, request.status()));
    }

    /**
     * Resets the two-step verification of an AUTHOR who lost the device: the enrollment and the recovery codes go, and the
     * author's sessions end. Needs the administrator's own code (and a recent sign-in). Never for an administrator: that is
     * the server owner's job (docs/SECURITY.md).
     */
    @PostMapping("/{id}/mfa/reset")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void resetMfa(@PathVariable UUID id, @Valid @RequestBody MeMfaCodeRequest request) {
        accountSecurityService.resetAuthorEnrollment(id, request.code());
    }

    /**
     * Changes a role. A change to or from ADMIN, or one that makes a reader an author, also needs the caller's own {@code code} in
     * the body and a sign-in from the last minutes (401 {@code REAUTHENTICATION_REQUIRED}, 401 {@code MFA_CODE_INVALID}...).
     */
    @PatchMapping("/{id}/role")
    public ApiResponse<UserAdminResponse> setRole(@PathVariable UUID id, @Valid @RequestBody UserRoleRequest request) {
        return ApiResponse.of(
                adminUserService.setRole(AuthenticatedUser.requireUserId(), id, request.role(), request.code()));
    }
}
