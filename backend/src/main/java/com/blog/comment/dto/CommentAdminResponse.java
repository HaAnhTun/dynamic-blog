package com.blog.comment.dto;

import com.blog.comment.entity.CommentStatus;
import com.blog.post.entity.PostStatus;
import com.blog.user.entity.UserRole;
import com.blog.user.entity.UserStatus;
import java.time.Instant;
import java.util.UUID;

/**
 * A comment as the moderation page sees it: always includes the content, even when hidden or deleted (moderation
 * history), together with its post and author. Only admins can read it.
 *
 * Only four columns of the post, never the post content; no email and no password hash of the author.
 *
 * @param status            {@code VISIBLE}, {@code HIDDEN} or {@code DELETED}
 * @param reply             is a reply, not a root comment
 * @param editedAt          the author's most recent edit; null when never edited
 * @param postStatus        {@code DRAFT}, {@code PUBLISHED} or {@code ARCHIVED}: comments on unpublished posts
 *                          can be moderated too
 * @param authorGithubLogin null for password-only accounts (ADMIN, AUTHOR not yet linked to GitHub)
 */
public record CommentAdminResponse(
        UUID id,
        String content,
        String status,
        boolean reply,
        Instant createdAt,
        Instant editedAt,
        UUID postId,
        String postSlug,
        String postTitle,
        String postStatus,
        UUID authorId,
        String authorDisplayName,
        String authorGithubLogin,
        String authorAvatarUrl,
        String authorRole,
        String authorStatus) {

    /**
     * For the Criteria query in CommentAdminQuery ({@code cb.construct}): takes the exact types of the entity
     * attributes (enums, {@code parentId}) and converts them to the API form, so the query selects the columns
     * directly without building any entity.
     */
    public CommentAdminResponse(
            UUID id,
            String content,
            CommentStatus status,
            UUID parentId,
            Instant createdAt,
            Instant editedAt,
            UUID postId,
            String postSlug,
            String postTitle,
            PostStatus postStatus,
            UUID authorId,
            String authorDisplayName,
            String authorGithubLogin,
            String authorAvatarUrl,
            UserRole authorRole,
            UserStatus authorStatus) {
        this(
                id,
                content,
                status.name(),
                parentId != null,
                createdAt,
                editedAt,
                postId,
                postSlug,
                postTitle,
                postStatus.name(),
                authorId,
                authorDisplayName,
                authorGithubLogin,
                authorAvatarUrl,
                authorRole.name(),
                authorStatus.name());
    }
}
