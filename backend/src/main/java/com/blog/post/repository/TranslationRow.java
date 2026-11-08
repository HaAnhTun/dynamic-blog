package com.blog.post.repository;

import java.util.UUID;

/** One published translation of a post group ({@link PostRepository#findPublishedTranslations}); a projection read by column alias. */
public interface TranslationRow {
    UUID getGroupId();

    UUID getPostId();

    String getLanguage();

    String getSlug();

    String getTitle();
}
