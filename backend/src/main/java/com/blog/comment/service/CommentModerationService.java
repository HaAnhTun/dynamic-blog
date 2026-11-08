package com.blog.comment.service;

import com.blog.comment.dto.CommentAdminResponse;
import com.blog.comment.entity.CommentStatus;
import com.blog.comment.repository.CommentAdminQuery;
import com.blog.comment.repository.CommentRepository;
import com.blog.comment.repository.CommentStateRow;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.text.LikePattern;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Admin comment moderation: list, hide, show again, soft delete. Every comment on every post, including
 * unpublished posts. Only ADMIN reaches this: the URL rule {@code /api/v1/admin/comments/**} in SecurityConfig.
 *
 * Each change is a conditional UPDATE that changes only its own source status (CommentRepository), and the number
 * of rows it changes decides the outcome; with 0 rows it reads again to learn why. Moderation and the author can
 * therefore run at the same time without overwriting each other: a hide does not turn a comment the author just
 * deleted into HIDDEN, a restore does not revive a deleted comment. It takes no lock other than the row lock of
 * the UPDATE itself, so there is no lock order that could collide with the reply path (parent row lock, then
 * per-user lock, in CommentService).
 */
@Service
@RequiredArgsConstructor
public class CommentModerationService {

    static final int MAX_PAGE_SIZE = 100;
    /** The largest page whose start offset (page x size) still fits an int, the type JPA uses for that offset. */
    private static final int MAX_PAGE = Integer.MAX_VALUE / MAX_PAGE_SIZE;

    private final CommentRepository commentRepository;
    private final CommentAdminQuery commentAdminQuery;

    /**
     * One page of the moderation list, newest first.
     *
     * @param status null means every status
     * @param q      searches content, login and author name, case-insensitive; null or blank means no search
     * @param postId only comments of this post; null means every post. An id that matches no post gives an empty page
     * @param page   from 0; a negative number is 0
     * @param size   clamped to 1..100
     */
    @Transactional(readOnly = true)
    public Page<CommentAdminResponse> list(CommentStatus status, String q, UUID postId, int page, int size) {
        PageRequest pageable = PageRequest.of(Math.clamp(page, 0, MAX_PAGE), Math.clamp(size, 1, MAX_PAGE_SIZE));
        return commentAdminQuery.find(status, LikePattern.contains(q), postId, pageable);
    }

    /**
     * Hides ({@code HIDDEN}) or shows again ({@code VISIBLE}) a comment. A comment already in the requested status
     * is left alone, and the response is still 200.
     *
     * @return the comment after the change, as a row of the list
     * @throws ApiException 400 {@code VALIDATION_ERROR} for {@code DELETED}: deletion has its own route; 404
     *                      {@code COMMENT_NOT_FOUND}; 409 {@code RESOURCE_CONFLICT} when the comment is already
     *                      deleted (DELETED is the final state), or its status changed to something else between
     *                      the write and the re-read
     */
    @Transactional
    public CommentAdminResponse setStatus(UUID id, CommentStatus target) {
        int changed = switch (target) {
            case HIDDEN -> commentRepository.hideIfVisible(id);
            case VISIBLE -> commentRepository.restoreIfHidden(id);
            case DELETED ->
                throw new ApiException(
                        ErrorCode.VALIDATION_ERROR,
                        HttpStatus.BAD_REQUEST,
                        "status must be VISIBLE or HIDDEN; delete a comment with DELETE");
        };
        if (changed == 0) {
            // No row changed: the comment does not exist (404), is already in the requested status (200, nothing to
            // do),
            // or is in a status this change cannot apply to (409). Read again to tell which case it is.
            String current = commentRepository
                    .findState(id)
                    .map(CommentStateRow::getStatus)
                    .orElseThrow(() -> notFound(id));
            if (!target.name().equals(current)) {
                throw new ApiException(
                        ErrorCode.RESOURCE_CONFLICT,
                        HttpStatus.CONFLICT,
                        CommentStatus.DELETED.name().equals(current)
                                ? "A deleted comment cannot be hidden or restored"
                                : "The comment changed status meanwhile; reload it and try again");
            }
        }
        return commentAdminQuery.findById(id).orElseThrow(() -> notFound(id));
    }

    /**
     * Soft-deletes a comment, visible or hidden: the content is kept as moderation history. Deleting an already
     * deleted comment still succeeds.
     *
     * @throws ApiException 404 {@code COMMENT_NOT_FOUND} when there is no such comment
     */
    @Transactional
    public void delete(UUID id) {
        // 0 rows: it does not exist, or was already DELETED. DELETED never changes to anything else, so if the row
        // exists it is deleted.
        if (commentRepository.softDeleteUnlessDeleted(id) == 0 && !commentRepository.existsById(id)) {
            throw notFound(id);
        }
    }

    private static ApiException notFound(UUID id) {
        return new ApiException(ErrorCode.COMMENT_NOT_FOUND, HttpStatus.NOT_FOUND, "Comment not found: " + id);
    }
}
