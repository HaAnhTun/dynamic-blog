package com.blog.user.dto;

import com.blog.user.entity.UserRole;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/**
 * The body of PATCH /api/v1/admin/users/{id}/role.
 *
 * @param code the acting administrator's own code (an authenticator code or a recovery code), needed when the change is to or from
 *             ADMIN or makes a reader an author (RoleChangeStepUp); ignored otherwise. {@link #toString()} is redacted.
 */
public record UserRoleRequest(
        @NotNull UserRole role, @Size(max = 64) String code) {

    @Override
    public String toString() {
        return "UserRoleRequest[role=" + role + ", code=redacted]";
    }
}
