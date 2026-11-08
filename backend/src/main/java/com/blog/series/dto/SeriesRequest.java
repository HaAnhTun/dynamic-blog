package com.blog.series.dto;

import com.blog.common.i18n.LocalizedText;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.Map;

/**
 * Create or edit a series. Editing replaces the whole title and description (a null or blank description clears it).
 *
 * @param translations optional, the title goes in {@code name}: absent keeps the stored map, present replaces it.
 * @param slug optional and always normalized. On create, when empty it is generated from the title. On edit, when empty the
 *             old slug is kept and not regenerated from the title: renaming a series must not change the public URL {@code /series/{slug}}.
 */
public record SeriesRequest(
        @NotBlank @Size(max = 255) String title,
        @Size(max = 255) String slug,
        @Size(max = 2000) String description,
        Map<String, LocalizedText> translations) {

    public SeriesRequest(String title, String slug, String description) {
        this(title, slug, description, null);
    }
}
