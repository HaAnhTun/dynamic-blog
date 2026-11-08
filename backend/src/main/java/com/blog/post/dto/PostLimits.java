package com.blog.post.dto;

/**
 * The size limits of the text of a post, in one place: the request validation ({@link PostCreateRequest},
 * {@link PostUpdateRequest}), the restore of a revision, the post file format and the CHECK constraints of migration V46 (which
 * repeat the numbers in SQL: a test keeps them equal). Counted in UTF-16 units, like Bean Validation's {@code @Size}.
 */
public final class PostLimits {

    public static final int TITLE_MAX = 255;
    public static final int EXCERPT_MAX = 1_000;
    public static final int CONTENT_MAX = 500_000;

    private PostLimits() {}
}
