package com.blog.post.security;

import com.blog.auth.support.AuthenticatedUser;
import com.blog.post.repository.PostRepository;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * The ownership half of the admin-post authorization rule.
 *
 * The role half lives in the filter chain ({@code /api/v1/admin/posts/**} requires ADMIN or AUTHOR)
 * and the two compose in {@code AdminPostController}'s {@code @PreAuthorize} expressions as
 * {@code hasRole('ADMIN') or @postAccess.isOwner(#id)}.
 *
 * <h2>Why a bean behind {@code @PreAuthorize} rather than a check inside the service</h2>
 *
 * A role fits in an annotation; "this row belongs to the caller" does not, because it needs a
 * query. Pushing the whole decision into {@code PostService} would have worked, but it would
 * have moved the denial off Spring Security's {@code AuthorizationDeniedException} path and
 * onto an ordinary {@code ApiException}. Those are different routes to the client:
 * {@code @PreAuthorize} denials reach {@code GlobalExceptionHandler.handleAccessDenied}, and
 * that route is the one Sprint 4a pinned with byte-level tests of the 403 envelope. Keeping
 * ownership in the annotation means an ownership denial is indistinguishable from a role
 * denial, which is both the correct answer for a caller and the one already under test.
 *
 * It also preserves a property the envelope tests depend on: a request for a post that does not
 * exist is refused with 403 rather than answered with 404. The check runs before the service
 * loads anything, so an AUTHOR cannot probe which post ids exist by reading status codes.
 * An ADMIN passes the check and gets the honest 404.
 *
 * <h2>Fail closed</h2>
 *
 * Every path that cannot positively establish ownership returns false: no principal, a
 * principal whose subject is not a usable id, a null post id, a post that does not exist.
 * None of those is an error here — the filter chain has already rejected an unauthenticated
 * request before any method-security expression runs — so the only question left is whether
 * this specific caller owns this specific row.
 */
@Component("postAccess")
@RequiredArgsConstructor
public class PostAccessPolicy {

    private final PostRepository postRepository;

    /**
     * True only when the authenticated caller is the post's author.
     *
     * Deliberately knows nothing about roles. The caller composes it with the role check, so
     * this method answering "false" for an ADMIN is correct and expected.
     */
    @Transactional(readOnly = true)
    public boolean isOwner(UUID postId) {
        if (postId == null) {
            return false;
        }
        return AuthenticatedUser.currentUserId()
                .flatMap(actor -> postRepository.findAuthorIdById(postId).map(actor::equals))
                .orElse(false);
    }
}
