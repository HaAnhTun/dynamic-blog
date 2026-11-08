package com.blog.category.dto;

import com.blog.common.i18n.LocalizedText;
import com.blog.common.text.SingleLine;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.Map;

/** {@code translations} is optional: absent keeps the stored map on update, present replaces it. */
public record CategoryRequest(
        @NotBlank @Size(max = 255) @SingleLine String name,
        String description,
        Map<String, LocalizedText> translations) {

    public CategoryRequest(String name, String description) {
        this(name, description, null);
    }
}
