package com.blog.user.dto;

import com.blog.user.entity.UserStatus;
import jakarta.validation.constraints.NotNull;

/**
 * The body of {@code PATCH /api/v1/admin/users/{id}/status}: {@code SUSPENDED} suspends, {@code ACTIVE} reactivates. It
 * only carries the status: the role is changed at {@code PATCH …/role}, so {@code role} or any other unknown field in
 * this body is ignored. An unknown value or wrong letter case is a 400 as soon as the body is read.
 */
public record UserStatusRequest(@NotNull UserStatus status) {}
