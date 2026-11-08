package com.blog.post.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.Set;
import java.util.UUID;

public record PostCreateRequest(
        @NotBlank @Size(max = PostLimits.TITLE_MAX) String title,
        @Size(max = PostLimits.EXCERPT_MAX) String excerpt,
        @NotBlank @Size(max = PostLimits.CONTENT_MAX) String content,
        UUID categoryId,
        /** At most 100 for anyone (the size of a request); an AUTHOR is held to {@code app.author-quota.max-tags-per-post}. */
        @Size(max = 100) Set<UUID> tagIds,
        /**
         * Optional. Blank or absent means "derive from the title". Whatever arrives is
         * slugified, so the stored value is always a legal URL segment even if the author
         * pastes a title into the box.
         */
        @Size(max = 255) String slug,
        /** Optional: an enabled locale. Absent means the default locale. */
        @Size(max = 8) String language) {

    public PostCreateRequest(
            String title, String excerpt, String content, UUID categoryId, Set<UUID> tagIds, String slug) {
        this(title, excerpt, content, categoryId, tagIds, slug, null);
    }
}
