package com.blog.tag.dto;

import com.blog.common.i18n.LocalizedText;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.Map;
import java.util.UUID;

/** See {@link com.blog.category.dto.CategoryResponse}: the same rules for {@code name} and {@code translations}. */
public record TagResponse(
        UUID id,
        String name,
        String slug,
        @JsonInclude(JsonInclude.Include.NON_NULL) Map<String, LocalizedText> translations) {

    public TagResponse(UUID id, String name, String slug) {
        this(id, name, slug, null);
    }
}
