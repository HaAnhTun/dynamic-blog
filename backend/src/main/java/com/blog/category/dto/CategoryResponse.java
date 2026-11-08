package com.blog.category.dto;

import com.blog.common.i18n.LocalizedText;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Map;
import java.util.UUID;

/**
 * {@code name} and {@code description} are the localized text when the request names a language ({@code lang}) or when the
 * category is embedded in a post (the post's language), with fallback to the base text. {@code translations} is the raw
 * map and only the admin endpoints fill it; elsewhere it is absent from the JSON.
 */
public record CategoryResponse(
        UUID id,
        String name,
        String slug,
        String description,
        @JsonInclude(JsonInclude.Include.NON_NULL) Map<String, LocalizedText> translations) {

    public CategoryResponse(UUID id, String name, String slug, String description) {
        this(id, name, slug, description, null);
    }
}
