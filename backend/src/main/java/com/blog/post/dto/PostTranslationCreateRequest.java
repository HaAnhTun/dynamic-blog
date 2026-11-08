package com.blog.post.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** Body of "create a translation draft": the language of the new post and, optionally, the slug it should take. */
public record PostTranslationCreateRequest(
        @NotBlank @Size(max = 8) String language,
        @Size(max = 255) String slug) {}
