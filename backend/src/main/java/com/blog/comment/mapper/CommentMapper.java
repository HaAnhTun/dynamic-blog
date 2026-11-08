package com.blog.comment.mapper;

import com.blog.comment.dto.CommentAuthorResponse;
import com.blog.comment.dto.CommentResponse;
import com.blog.comment.entity.Comment;
import com.blog.comment.entity.CommentStatus;
import com.blog.common.security.SeedAdmin;
import com.blog.user.entity.User;
import com.blog.user.service.PublicSlugs;
import java.util.UUID;

/**
 * Comment entity to public DTO. Never includes a user id, email or role; only a "site owner" flag
 * ({@link CommentAuthorResponse#siteOwner}): the author is the seeded admin row, not every ADMIN.
 *
 * Call inside a transaction, with the author already loaded (join fetch) or loadable: {@code author} is a LAZY
 * relation and open-in-view is off.
 */
public final class CommentMapper {

    private CommentMapper() {}

    /**
     * @param viewerId the current viewer; null when anonymous. Used only to compute {@code mine}, never returned.
     * @param likes    likes read in batch for the comments being returned; {@link CommentLikeStats#EMPTY}
     *                 for a freshly created comment
     */
    public static CommentResponse toResponse(Comment comment, UUID viewerId, CommentLikeStats likes) {
        if (comment.getStatus() != CommentStatus.VISIBLE) {
            // Placeholder for a hidden or deleted root that still has replies: only its position and kind, nothing of
            // the content, author, edit time or likes, even for the author themselves.
            return new CommentResponse(
                    comment.getId(),
                    comment.getStatus().name(),
                    null,
                    null,
                    comment.getCreatedAt(),
                    false,
                    false,
                    null,
                    0,
                    false);
        }
        User author = comment.getAuthor();
        return new CommentResponse(
                comment.getId(),
                CommentStatus.VISIBLE.name(),
                comment.getContent(),
                new CommentAuthorResponse(
                        author.getDisplayName(),
                        author.getGithubLogin(),
                        author.getAvatarUrl(),
                        SeedAdmin.ID.equals(author.getId()),
                        PublicSlugs.profileSlugOf(author)),
                comment.getCreatedAt(),
                comment.getEditedAt() != null,
                author.getId().equals(viewerId),
                comment.getEditedAt(),
                likes.countOf(comment.getId()),
                likes.isLikedByViewer(comment.getId()));
    }
}
