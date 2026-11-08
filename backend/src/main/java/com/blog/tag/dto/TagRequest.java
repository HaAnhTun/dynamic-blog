package com.blog.tag.dto;

import com.blog.common.i18n.LocalizedText;
import com.blog.common.text.SingleLine;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.Map;

/** {@code translations} is optional: absent keeps the stored map on update, present replaces it. Tags have no description. */
public record TagRequest(
        @NotBlank @Size(max = 100) @SingleLine String name, Map<String, LocalizedText> translations) {

    public TagRequest(String name) {
        this(name, null);
    }
}
