package com.blog.author.dto;

import jakarta.validation.constraints.Size;

/**
 * Body of an application submission: only the optional motivation. The applicant is always the token owner; unknown
 * fields (userId, role, status...) are ignored.
 *
 * {@code @Size} only rejects an oversized body early, counting UTF-16 units; the real rule is at most 500 characters
 * after sanitizing, counted by code point (AuthorApplicationService).
 */
public record AuthorApplicationRequest(@Size(max = 2000) String motivation) {}
