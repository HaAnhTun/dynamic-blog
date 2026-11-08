package com.blog.post.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.post.dto.PostRevisionResponse;
import com.blog.post.dto.PostRevisionSummaryResponse;
import com.blog.post.entity.Post;
import com.blog.post.entity.PostRevision;
import com.blog.post.repository.PostRepository;
import com.blog.post.repository.PostRevisionRepository;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Post revisions, the simplest way that still rescues a post: before a save that changes the text, keep the old text.
 *
 * <ul>
 *   <li><b>When one is written.</b> A save (PUT post) that changes the title, excerpt or content records the state
 *       BEFORE that save. Slug, category, tags, publish, unpublish, featuring, series and cover write nothing: they do
 *       not go through here, or the text does not change.</li>
 *   <li><b>Coalescing.</b> If the post already has a revision within the latest {@link #COALESCE_WINDOW}, the save does
 *       not write another: a writing session that hits Save ten times does not become ten almost identical revisions.
 *       The price: what was written between two saves in the same window has no revision of its own, i.e. at most that
 *       many minutes of work are lost, which the editor's autosave takes care of.</li>
 *   <li><b>Limit.</b> Each post keeps its {@link #KEPT_PER_POST} newest revisions; older ones are deleted right in the
 *       write, so the table does not grow with the number of edits.</li>
 *   <li><b>Restore</b> (PostService.restoreRevision) records the current state first, WITHOUT coalescing, so every
 *       restore can be undone with the revision it just wrote.</li>
 * </ul>
 *
 * Every write runs inside the post edit's transaction (propagation REQUIRED): a save that fails at any later step
 * (missing category, missing tag) also rolls back the revision just written. Times (the write and the window) follow
 * the application's clock, like the post's {@code updated_at}.
 */
@Service
@RequiredArgsConstructor
public class PostRevisionService {

    /** Saves closer than this to the latest revision are coalesced into one. */
    public static final Duration COALESCE_WINDOW = Duration.ofMinutes(10);
    /** Number of revisions kept per post. */
    public static final int KEPT_PER_POST = 20;

    private final PostRevisionRepository revisionRepository;
    private final PostRepository postRepository;

    /**
     * Records the current text of {@code post} as a revision, if the edit about to be applied really changes the text and
     * the post has no revision within {@link #COALESCE_WINDOW}. Call BEFORE assigning the new text to the post: this is
     * the only place where the old text can still be read.
     *
     * @param title   the title the edit is about to assign
     * @param excerpt the excerpt the edit is about to assign
     * @param content the content the edit is about to assign
     * @param editor  the person saving, from the token
     */
    @Transactional
    public void recordBeforeEdit(Post post, String title, String excerpt, String content, UUID editor) {
        boolean textChanges = !Objects.equals(post.getTitle(), title)
                || !Objects.equals(post.getExcerpt(), excerpt)
                || !Objects.equals(post.getContent(), content);
        if (!textChanges) {
            return;
        }
        if (revisionRepository.existsByPostIdAndCreatedAtAfter(
                post.getId(), Instant.now().minus(COALESCE_WINDOW))) {
            return;
        }
        record(post, editor);
    }

    /**
     * Records the current text of {@code post} as a revision, without coalescing, then drops the revisions older than
     * the post's {@link #KEPT_PER_POST} newest.
     */
    @Transactional
    public void record(Post post, UUID editor) {
        write(post, editor);
    }

    /**
     * Loads the post and records its current text as a revision, without coalescing (see {@link #record}), then returns the
     * id of that revision. For a caller that must be able to put exactly this text back later (the post import records the
     * text it is about to replace, then updates the post: that update finds this revision younger than the window and writes
     * no second one). The caller holds whatever lock its write needs.
     *
     * @throws ApiException 404 {@code POST_NOT_FOUND}
     */
    @Transactional
    public UUID recordCurrent(UUID postId, UUID editor) {
        Post post = postRepository
                .findById(postId)
                .orElseThrow(() ->
                        new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + postId));
        return write(post, editor);
    }

    private UUID write(Post post, UUID editor) {
        UUID id = revisionRepository.save(PostRevision.of(post, editor)).getId();
        revisionRepository.deleteAllButNewest(post.getId(), KEPT_PER_POST);
        return id;
    }

    /**
     * The post's history, newest first, without content.
     *
     * @throws ApiException 404 {@code POST_NOT_FOUND}
     */
    @Transactional(readOnly = true)
    public List<PostRevisionSummaryResponse> list(UUID postId) {
        requirePost(postId);
        return revisionRepository.findSummariesByPostId(postId);
    }

    /**
     * One full revision.
     *
     * @throws ApiException 404 {@code POST_NOT_FOUND} when there is no post; 404 {@code REVISION_NOT_FOUND} when the
     *                      revision does not exist or belongs to another post
     */
    @Transactional(readOnly = true)
    public PostRevisionResponse get(UUID postId, UUID revisionId) {
        requirePost(postId);
        PostRevision revision = find(postId, revisionId);
        return new PostRevisionResponse(
                revision.getId(),
                revision.getTitle(),
                revision.getExcerpt(),
                revision.getContent(),
                revision.getCreatedAt());
    }

    /**
     * Revision {@code revisionId} of post {@code postId}, for restoring. Does not check the post: the caller has already
     * loaded (and locked) it.
     *
     * @throws ApiException 404 {@code REVISION_NOT_FOUND} when the revision does not exist or belongs to another post
     */
    @Transactional(readOnly = true)
    public PostRevision find(UUID postId, UUID revisionId) {
        return revisionRepository
                .findByIdAndPostId(revisionId, postId)
                .orElseThrow(() -> new ApiException(
                        ErrorCode.REVISION_NOT_FOUND,
                        HttpStatus.NOT_FOUND,
                        "No revision " + revisionId + " of post " + postId));
    }

    private void requirePost(UUID postId) {
        if (!postRepository.existsById(postId)) {
            throw new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + postId);
        }
    }
}
