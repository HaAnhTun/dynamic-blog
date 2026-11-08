package com.blog.auth.entity;

/** The state of a {@link UserMfa} row: {@code PENDING} until the first code of the new secret is confirmed. */
public enum MfaStatus {
    PENDING,
    ACTIVE
}
