package com.blog.post.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.Set;
import java.util.UUID;

public record PostUpdateRequest(
        @NotBlank @Size(max = PostLimits.TITLE_MAX) String title,
        @Size(max = PostLimits.EXCERPT_MAX) String excerpt,
        @NotBlank @Size(max = PostLimits.CONTENT_MAX) String content,
        UUID categoryId,
        /** At most 100 for anyone (the size of a request); an AUTHOR is held to {@code app.author-quota.max-tags-per-post}. */
        @Size(max = 100) Set<UUID> tagIds,
        /**
         * Optional, and here blank means something different from create: "leave the slug
         * as it is". It must NOT re-derive from the title, because a published post's URL
         * has to survive a typo being fixed in its title.
         */
        @Size(max = 255) String slug,
        /** Optional: an enabled locale. Absent means "keep the language". */
        @Size(max = 8) String language) {

    public PostUpdateRequest(
            String title, String excerpt, String content, UUID categoryId, Set<UUID> tagIds, String slug) {
        this(title, excerpt, content, categoryId, tagIds, slug, null);
    }
}
