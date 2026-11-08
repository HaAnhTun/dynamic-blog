package com.blog.auth.entity;

/** How a person proved who they are before the second step: the one gate (AuthService.completeFirstFactor) takes both. */
public enum FirstFactor {
    PASSWORD,
    GITHUB
}
