package com.blog.post.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.media.entity.Media;
import com.blog.media.service.MediaService;
import com.blog.media.service.PreparedUpload;
import com.blog.post.dto.PostResponse;
import com.blog.post.entity.Post;
import com.blog.post.repository.PostRepository;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.multipart.MultipartFile;

/**
 * Cover image of a post: uploaded and attached in one call, description edit, detach.
 *
 * A cover image is only created through its post and belongs to exactly that post ({@code idx_posts_cover_media_id} is
 * unique), so replacing or detaching a cover also deletes the old image: there are no orphan images, and no policy is
 * needed about who owns which image. The permission on the cover is the permission on the post, checked in the
 * controller ({@code CAN_MANAGE}).
 *
 * No class-level {@code @Transactional}: upload processes the image (a few hundred ms up to a few seconds) OUTSIDE a
 * transaction, as {@link MediaService#prepare} requires, and only then opens a short transaction to save the image and
 * attach it to the post. The image and the attachment commit or roll back together: an error at any step after saving
 * the image leaves no image behind.
 *
 * Every operation reads the current cover under the post's row lock ({@link PostRepository#findByIdForUpdate}), because
 * it decides which image gets deleted. The post is reloaded after the write and mapped to a DTO in the same
 * transaction (LAZY relations).
 */
@Service
public class PostCoverService {

    private final MediaService mediaService;
    private final PostRepository postRepository;
    private final PostService postService;
    private final TransactionTemplate transactionTemplate;

    public PostCoverService(
            MediaService mediaService,
            PostRepository postRepository,
            PostService postService,
            PlatformTransactionManager transactionManager) {
        this.mediaService = mediaService;
        this.postRepository = postRepository;
        this.postService = postService;
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    /**
     * Processes the image, saves it, attaches it as the cover, then deletes the old cover (if any). The quota counts only
     * the increase: the old image is deleted in the same transaction, so close to the quota a new image that fits once the
     * old one is gone is still accepted.
     *
     * @throws ApiException 404 {@code POST_NOT_FOUND} when there is no post, 400 {@code VALIDATION_ERROR} when the
     *                      description is over 300 characters (both checked before spending effort on the image); any
     *                      error of {@link MediaService#prepare} and {@link MediaService#persist} (400, 413, 415, 422,
     *                      503), in which case the existing cover is left intact
     */
    public PostResponse upload(UUID postId, MultipartFile file, String altText, UUID uploader) {
        // Cheap checks before expensive ones: if the post does not exist, the answer is about the post, not about an
        // image that was just decoded only to be thrown away. The post may still be deleted while the image is
        // processed;
        // then the locked lookup below returns 404.
        if (!postRepository.existsById(postId)) {
            throw postNotFound(postId);
        }
        // A description that is too long is the same: check here (persist normalises again when saving) so a request
        // that
        // is going to fail anyway does not hold the server's single image-processing slot.
        MediaService.normalizeAltText(altText);
        PreparedUpload prepared = mediaService.prepare(file, uploader);
        return replace(postId, prepared, altText, uploader);
    }

    /**
     * The part of {@link #upload} that needs a transaction, for a caller that prepared the image itself (the post import):
     * saves the prepared image, attaches it as the cover and deletes the old cover, if any, so a cover replaced here goes the
     * way a cover replaced by the editor goes. Joins the transaction of the caller when there is one, and then the caller must
     * already have prepared the image outside of it.
     *
     * @throws ApiException 404 {@code POST_NOT_FOUND} when there is no post; 400 {@code VALIDATION_ERROR} when the
     *                      description is over 300 characters; 422 {@code MEDIA_QUOTA_EXCEEDED}
     */
    public PostResponse replace(UUID postId, PreparedUpload prepared, String altText, UUID uploader) {
        return inTransaction(() -> {
            UUID previous = coverIdOf(lockPost(postId));
            Media media = mediaService.persist(prepared, altText, uploader, previous);
            postRepository.setCover(postId, media.getId());
            if (previous != null) {
                mediaService.delete(previous);
            }
            return postService.getById(postId);
        });
    }

    /**
     * Replaces the cover description (null or a blank string clears it). The image is unchanged.
     *
     * @throws ApiException 404 {@code POST_NOT_FOUND} when there is no post; 404 {@code MEDIA_NOT_FOUND} when the post has
     *                      no cover; 400 {@code VALIDATION_ERROR} when the description is longer than 300 characters
     */
    public PostResponse updateAltText(UUID postId, String altText) {
        return inTransaction(() -> {
            UUID cover = coverIdOf(lockPost(postId));
            if (cover == null) {
                throw new ApiException(
                        ErrorCode.MEDIA_NOT_FOUND, HttpStatus.NOT_FOUND, "Post has no cover image: " + postId);
            }
            mediaService.updateAltText(cover, altText);
            return postService.getById(postId);
        });
    }

    /**
     * Detaches the cover and deletes the image. Idempotent: a post with no cover is returned as it is (a repeated removal
     * from two admin tabs is not an error).
     *
     * @throws ApiException 404 {@code POST_NOT_FOUND} when there is no post
     */
    public PostResponse remove(UUID postId) {
        return inTransaction(() -> {
            UUID cover = coverIdOf(lockPost(postId));
            if (cover != null) {
                // Detach from the post before deleting the image, even though ON DELETE SET NULL would also do it:
                // setCover
                // clears the persistence context, so the post reloaded below no longer points at a deleted image.
                postRepository.setCover(postId, null);
                mediaService.delete(cover);
            }
            return postService.getById(postId);
        });
    }

    private Post lockPost(UUID postId) {
        return postRepository.findByIdForUpdate(postId).orElseThrow(() -> postNotFound(postId));
    }

    /** The id is read from the LAZY proxy, without loading the image. */
    private static UUID coverIdOf(Post post) {
        return post.getCover() == null ? null : post.getCover().getId();
    }

    private PostResponse inTransaction(Supplier<PostResponse> work) {
        return transactionTemplate.execute(status -> work.get());
    }

    private static ApiException postNotFound(UUID postId) {
        return new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + postId);
    }
}
