package com.blog.post.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.media.dto.MediaResponse;
import com.blog.media.entity.Media;
import com.blog.media.mapper.MediaMapper;
import com.blog.media.repository.MediaRepository;
import com.blog.media.service.MediaService;
import com.blog.media.service.PreparedUpload;
import com.blog.post.repository.PostRepository;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.multipart.MultipartFile;

/**
 * Images in the post body: upload, list, delete. An image belongs to exactly the post it was uploaded for
 * ({@code media.post_id}), so the permission on the image is the permission on the post, checked in the controller
 * ({@code CAN_MANAGE}), like the cover (PostCoverService).
 *
 * The service inserts nothing into the post: the editor puts {@code ![description](/media/<fileName>)} into the
 * Markdown. So the backend does not know which images the body still uses: deleting an image the post still points at
 * breaks that image in the post, and an image removed from the text stays (and still counts toward the quota) until it
 * is deleted here or together with the post. That is a deliberate trade-off: reading the Markdown to guess which image
 * is "still in use" would be wrong with revisions, unsaved drafts, or another post copying the link.
 *
 * No class-level {@code @Transactional}, for the same reason as PostCoverService: the image is processed (a few hundred
 * ms up to a few seconds) OUTSIDE a transaction ({@link MediaService#prepare}), then a short transaction saves the
 * image under the post's row lock ({@link PostRepository#findByIdForUpdate}). That lock queues an upload behind a
 * post deletion that is running: the upload waits, then finds the post gone (404) instead of tripping over the foreign
 * key on write. An image cannot become an orphan even without the lock: the post_id foreign key forbids an image
 * pointing at a post that no longer exists. Deleting an image also runs under that lock ({@link #delete}).
 */
@Service
public class PostImageService {

    private final MediaService mediaService;
    private final MediaRepository mediaRepository;
    private final PostRepository postRepository;
    private final TransactionTemplate transactionTemplate;

    public PostImageService(
            MediaService mediaService,
            MediaRepository mediaRepository,
            PostRepository postRepository,
            PlatformTransactionManager transactionManager) {
        this.mediaService = mediaService;
        this.mediaRepository = mediaRepository;
        this.postRepository = postRepository;
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    /**
     * Processes the image like a cover image (same formats, limits, pipeline) and then saves it as an image in the post
     * body. The same quota as every image of the site.
     *
     * @throws ApiException 404 {@code POST_NOT_FOUND} when there is no post, 400 {@code VALIDATION_ERROR} when the
     *                      description is over 300 characters (both checked before spending effort on the image); any
     *                      error of {@link MediaService#prepare} and {@link MediaService#persistForPost} (400, 413, 415,
     *                      422, 503), in which case nothing is saved
     */
    public MediaResponse upload(UUID postId, MultipartFile file, String altText, UUID uploader) {
        // Cheap checks before expensive ones, like the cover: if the post does not exist, the answer is about
        // the post, not about a just-decoded image.
        requirePost(postId);
        MediaService.normalizeAltText(altText);
        // An AUTHOR's post holds a bounded number of images; an ADMIN's does not.
        mediaService.requireRoomForBodyImage(postId, uploader);
        PreparedUpload prepared = mediaService.prepare(file, uploader);
        return inTransaction(() -> {
            lockPost(postId);
            return MediaMapper.toResponse(mediaService.persistForPost(prepared, altText, uploader, postId));
        });
    }

    /**
     * The images in the post body, newest first. No cover image and no gallery image.
     *
     * @throws ApiException 404 {@code POST_NOT_FOUND}
     */
    public List<MediaResponse> list(UUID postId) {
        return inTransaction(() -> {
            requirePost(postId);
            return imagesOf(postId);
        });
    }

    /**
     * Deletes one image from the post body; the bytes go with it through {@code ON DELETE CASCADE}, and the public URL
     * becomes 404. Does not edit the post's Markdown. Returns the remaining images (200 with a body: admin-api cannot
     * read a 204).
     *
     * Looks the image up under the post's row lock, like every cover operation: two overlapping deletions of the same
     * image (repeated click, two tabs) make the later one wait for the earlier to commit and then not find the image
     * (404). Without the lock both see the image, and the later DELETE statement touches 0 rows: Hibernate treats that
     * as a write conflict, which becomes a 500.
     *
     * @throws ApiException 404 {@code POST_NOT_FOUND} when there is no post; 404 {@code MEDIA_NOT_FOUND} when the image is
     *                      not an image in this post's body: a cover image, a gallery image, another post's image, or
     *                      already deleted
     */
    public List<MediaResponse> delete(UUID postId, UUID mediaId) {
        return inTransaction(() -> {
            lockPost(postId);
            Media image = mediaRepository
                    .findByIdAndPostId(mediaId, postId)
                    .orElseThrow(() -> new ApiException(
                            ErrorCode.MEDIA_NOT_FOUND,
                            HttpStatus.NOT_FOUND,
                            "Not an image of post " + postId + ": " + mediaId));
            mediaService.delete(image.getId());
            // The read below touches the media table, so Hibernate writes the delete first: the deleted image
            // is not in the list.
            return imagesOf(postId);
        });
    }

    private List<MediaResponse> imagesOf(UUID postId) {
        return mediaRepository.findAllByPostIdOrderByCreatedAtDescIdDesc(postId).stream()
                .map(MediaMapper::toResponse)
                .toList();
    }

    private void requirePost(UUID postId) {
        if (!postRepository.existsById(postId)) {
            throw postNotFound(postId);
        }
    }

    private void lockPost(UUID postId) {
        postRepository.findByIdForUpdate(postId).orElseThrow(() -> postNotFound(postId));
    }

    private <T> T inTransaction(Supplier<T> work) {
        return transactionTemplate.execute(status -> work.get());
    }

    private static ApiException postNotFound(UUID postId) {
        return new ApiException(ErrorCode.POST_NOT_FOUND, HttpStatus.NOT_FOUND, "Post not found: " + postId);
    }
}
