package com.blog.post.dto;

import java.util.UUID;

/** A sibling in the admin translation panel: the id lets the editor open it, and the status can be any the caller may see. */
public record AdminPostTranslationResponse(UUID id, String language, String slug, String title, String status) {}
