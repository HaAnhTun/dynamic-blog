package com.blog.post.entity;

/**
 * Status of a post. The application only assigns two values: {@link #DRAFT} (create, unpublish) and
 * {@link #PUBLISHED} (publish).
 */
public enum PostStatus {
    DRAFT,
    PUBLISHED,
    /**
     * Reserved: no API path and no line of application code assigns this value, and the admin UI no longer has a
     * filter or count label for it. Kept in the enum because a row carrying it (written by hand in SQL, legacy data)
     * must still be readable, and every public path already filters by {@link #PUBLISHED}, so such a post never leaks:
     * the leak-prevention tests (posts, comments, likes) write it with SQL to keep that true. Using it for real would
     * need an "archive" action together with its SEO rules (404/410, removal from the sitemap and feed), not just
     * assigning the value. One path does assign it since V49: an AUTHOR's delete of their own post hides it as ARCHIVED with
     * {@code deleted_at} set, and an ADMIN sees it under that status.
     */
    ARCHIVED
}
