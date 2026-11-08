package com.blog.media.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.quota.AuthorQuotaProperties;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.common.text.UserText;
import com.blog.media.config.MediaProperties;
import com.blog.media.dto.MediaUsageResponse;
import com.blog.media.entity.Media;
import com.blog.media.entity.MediaContent;
import com.blog.media.repository.MediaContentRepository;
import com.blog.media.repository.MediaRepository;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.time.Duration;
import java.util.UUID;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

/**
 * Stores, edits, deletes and serves images. There is no standalone upload endpoint: an image is only created together
 * with the resource that owns it (cover image, gallery photo, a post body image (V25)), so this service is a
 * library for those modules, plus the public serving path and the used-size figure.
 *
 * Upload is deliberately two steps: {@link #prepare} (file checks, image pipeline, OUTSIDE a transaction) and then
 * {@link #persist} (a short transaction). That is why this class has no class-level {@code @Transactional}: wrapping
 * prepare in a transaction would hold a DB connection for the several seconds of decoding and encoding, for work that
 * needs no DB.
 */
@Service
public class MediaService {

    /**
     * The most images read from the database at the same time to be served. Each read puts the whole image (up to 4 MiB) in the
     * heap as one array, so a crowd asking for large pictures at once can use all of a 512 MB container and end the process
     * ({@code -XX:+ExitOnOutOfMemoryError}); eight at once is at most 32 MB. A ninth waits {@link #READ_WAIT} for a turn and then gets
     * 503 {@code MEDIA_BUSY}, which the Next route turns into a 502 that is never cached.
     */
    static final int MAX_CONCURRENT_READS = 8;

    /** A read takes milliseconds, so a read that waits this long is behind a crowd: it is refused rather than left holding a thread. */
    static final Duration READ_WAIT = Duration.ofSeconds(2);

    private final ImageProcessor imageProcessor;
    private final MediaRepository mediaRepository;
    private final MediaContentRepository mediaContentRepository;
    private final long maxUploadBytes;
    private final long maxTotalBytes;
    private final Duration processingWait;
    private final Semaphore processingPermits;
    private final Semaphore readPermits = new Semaphore(MAX_CONCURRENT_READS, true);
    /**
     * The one place an AUTHOR waits for the image pipeline: at most one author image is processing or waiting for the permit,
     * so an ADMIN's upload waits behind at most one author image, however many an author sends.
     */
    private final Semaphore authorGate = new Semaphore(1, true);

    private final RateLimiter rateLimiter;
    private final AuthorQuotaProperties authorQuota;
    private final long maxTotalAuthorBytes;
    private final long maxAuthorBytes;

    public MediaService(
            ImageProcessor imageProcessor,
            MediaProperties properties,
            MediaRepository mediaRepository,
            MediaContentRepository mediaContentRepository,
            RateLimiter rateLimiter,
            AuthorQuotaProperties authorQuota) {
        this.imageProcessor = imageProcessor;
        this.mediaRepository = mediaRepository;
        this.mediaContentRepository = mediaContentRepository;
        this.rateLimiter = rateLimiter;
        this.authorQuota = authorQuota;
        this.maxUploadBytes = properties.maxUploadSize().toBytes();
        this.maxTotalBytes = properties.maxTotalSize().toBytes();
        this.maxAuthorBytes = authorQuota.mediaPerAuthor().toBytes();
        this.maxTotalAuthorBytes = maxTotalBytes / 100 * authorQuota.mediaAllAuthorsPercent();
        this.processingWait = properties.processingWait();
        // One large image takes up to a hundred MB of heap while being processed; two at once in a 512 MB container is
        // enough for an OOM.
        // Fair: the image that has waited longest is processed first, and later arrivals cannot cut in until its wait
        // times out.
        this.processingPermits = new Semaphore(properties.processingPermits(), true);
    }

    /**
     * Checks the file, then runs the image pipeline, at most {@code processing-permits} images at once. For an upload by an
     * ADMIN (gallery, About photo, site import): it counts against no per-author limit. Where the uploader can be an AUTHOR use
     * {@link #prepare(MultipartFile, UUID)}.
     *
     * @throws ApiException 400 {@code VALIDATION_ERROR} when the file is missing or empty;
     *                      413 {@code MEDIA_TOO_LARGE} when the file is larger than {@code max-upload-size};
     *                      503 {@code MEDIA_BUSY} when the wait exceeds {@code processing-wait} without getting a turn;
     *                      and every {@code MEDIA_*} error of {@link ImageProcessor#process}
     */
    public PreparedUpload prepare(MultipartFile file) {
        // The size declared in the part is checked before reading: do not pull the whole file into the heap just to
        // discard it. Spring already blocks at max-file-size for real clients, but MockMvc and any path that bypasses
        // Tomcat does not. The bytes are read AFTER getting a permit: uploads waiting in the queue do not each hold 10
        // MB.
        return prepare(file, true);
    }

    /**
     * Like {@link #prepare(MultipartFile)}, for an image that is already in memory (an image of an imported ZIP package): the
     * same checks, the same pipeline and the same processing permits, OUTSIDE a transaction.
     *
     * @param originalFilename the name to keep for the admin to recognize the image, cleaned like an uploaded file's; may be null
     * @throws ApiException like {@link #prepare(MultipartFile)}
     */
    public PreparedUpload prepare(byte[] data, String originalFilename) {
        return prepare(data, originalFilename, true);
    }

    /**
     * {@link #prepare(MultipartFile)} for an upload by an account that may be an AUTHOR (a cover or a body image of a post): an
     * ADMIN is treated exactly like {@link #prepare(MultipartFile)}; anyone else first counts against {@code app.rate-limit.media-upload}
     * (429 {@code RATE_LIMITED}) and then waits for the pipeline behind the author gate, so that one author cannot keep
     * the site's single processing permit busy. Use this, not the one-argument form, wherever the uploader can be an AUTHOR.
     *
     * @param uploader the account that sends the image; one that is unknown counts as an AUTHOR
     * @throws ApiException like {@link #prepare(MultipartFile)}, and 429 {@code RATE_LIMITED}
     */
    public PreparedUpload prepare(MultipartFile file, UUID uploader) {
        boolean admin = isAdmin(uploader);
        if (!admin) {
            rateLimiter.check(RateLimiter.MEDIA_UPLOAD, uploader);
        }
        return prepare(file, admin);
    }

    /**
     * {@link #prepare(byte[], String)} for an image of an import by an account that may be an AUTHOR: same gate as
     * {@link #prepare(MultipartFile, UUID)}, but not counted against {@code app.rate-limit.media-upload}: an import has its own
     * limit ({@code post-import-write}) and carries many images.
     */
    public PreparedUpload prepare(byte[] data, String originalFilename, UUID uploader) {
        return prepare(data, originalFilename, isAdmin(uploader));
    }

    private PreparedUpload prepare(MultipartFile file, boolean admin) {
        if (file == null || file.isEmpty()) {
            throw new ApiException(ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "The uploaded file is empty");
        }
        if (file.getSize() > maxUploadBytes) {
            throw tooLarge("The uploaded file is " + file.getSize() + " bytes; at most " + maxUploadBytes
                    + " bytes are accepted");
        }
        return process(() -> readBytes(file), cleanOriginalFilename(file.getOriginalFilename()), admin);
    }

    private PreparedUpload prepare(byte[] data, String originalFilename, boolean admin) {
        if (data == null || data.length == 0) {
            throw new ApiException(ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "The image is empty");
        }
        if (data.length > maxUploadBytes) {
            throw tooLarge("The image is " + data.length + " bytes; at most " + maxUploadBytes + " bytes are accepted");
        }
        return process(() -> data, cleanOriginalFilename(originalFilename), admin);
    }

    private static ApiException tooLarge(String message) {
        return new ApiException(ErrorCode.MEDIA_TOO_LARGE, HttpStatus.CONTENT_TOO_LARGE, message);
    }

    private PreparedUpload process(Supplier<byte[]> bytes, String originalFilename, boolean admin) {
        if (!admin) {
            acquire(authorGate);
        }
        try {
            acquireProcessingPermit();
            try {
                return new PreparedUpload(imageProcessor.process(bytes.get()), originalFilename);
            } finally {
                processingPermits.release();
            }
        } finally {
            if (!admin) {
                authorGate.release();
            }
        }
    }

    private void acquire(Semaphore gate) {
        boolean acquired;
        try {
            acquired = gate.tryAcquire(processingWait.toNanos(), TimeUnit.NANOSECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            acquired = false;
        }
        if (!acquired) {
            throw new ApiException(
                    ErrorCode.MEDIA_BUSY,
                    HttpStatus.SERVICE_UNAVAILABLE,
                    "Another image is being processed; try again in a moment");
        }
    }

    /** Whether this account is an ADMIN (exempt from the limits of an AUTHOR). A missing or unknown account is not. */
    private boolean isAdmin(UUID account) {
        return account != null
                && mediaRepository
                        .findRoleOfUser(account)
                        .filter("ADMIN"::equals)
                        .isPresent();
    }

    /**
     * Before an AUTHOR uploads one more image into the body of a post: refuses it when the post already holds
     * {@code app.author-quota.max-body-images-per-post} images. An ADMIN is exempt.
     *
     * @throws ApiException 422 {@code AUTHOR_QUOTA_EXCEEDED}
     */
    @Transactional(readOnly = true)
    public void requireRoomForBodyImage(UUID postId, UUID uploader) {
        if (!isAdmin(uploader) && mediaRepository.countByPostId(postId) >= authorQuota.maxBodyImagesPerPost()) {
            throw new ApiException(
                    ErrorCode.AUTHOR_QUOTA_EXCEEDED,
                    HttpStatus.UNPROCESSABLE_CONTENT,
                    "A post can hold at most " + authorQuota.maxBodyImagesPerPost() + " images; remove one first");
        }
    }

    /**
     * Stores a processed image: metadata then bytes, in one transaction. Propagation is REQUIRED, so when called from
     * inside the owner's transaction (attaching a cover, creating a gallery photo) the image and its owner commit or
     * roll back together: no orphan images.
     *
     * The quota is checked inside this very transaction but without locking: two uploads at exactly the same moment near
     * the quota can both get through, each exceeding it by at most one image (up to 4 MiB). The quota is a soft barrier
     * to keep the DB (Neon free tier) from filling up, not a billing limit, so it is not worth a table-wide lock on
     * every upload.
     *
     * @throws ApiException 400 {@code VALIDATION_ERROR} when the alt text is longer than 300 characters;
     *                      422 {@code MEDIA_QUOTA_EXCEEDED} when the total size would exceed {@code max-total-size}
     */
    @Transactional
    public Media persist(PreparedUpload upload, String altText, UUID uploadedBy) {
        return persist(upload, altText, uploadedBy, null);
    }

    /**
     * Like {@link #persist(PreparedUpload, String, UUID)}, for an image that will REPLACE the image {@code replacing} in
     * the same transaction (replacing a cover): the quota is computed as if the old image were already gone, i.e. only
     * the increase counts. Counting the old image too would, near the quota, return 422 even for replacing a cover with a
     * smaller image, although after the replacement the site uses less space than before.
     *
     * Does not delete the old image itself: the caller detaches it from its owner and then deletes it ({@link #delete}) in
     * the same transaction, like PostCoverService. It subtracts using the number read from the metadata table rather
     * than deleting first and then computing the total: that only works because Hibernate auto-flushes the delete before
     * the total query, something that is visible nowhere in the code.
     *
     * @param replacing the image that will be deleted; null, or an id with no image left, means nothing to subtract (like a new image)
     * @throws ApiException like {@link #persist(PreparedUpload, String, UUID)}
     */
    @Transactional
    public Media persist(PreparedUpload upload, String altText, UUID uploadedBy, UUID replacing) {
        return store(upload, altText, uploadedBy, replacing, null);
    }

    /**
     * Like {@link #persist(PreparedUpload, String, UUID)}, for an image in a post body: the image carries the
     * {@code post_id} of the post that owns it, so it is listed per post and goes with the post when the post is deleted.
     * Same quota as every other image (cover, gallery): one pool of storage for the whole site.
     *
     * @param postId the post that owns the image; the caller has already checked that the post exists (and holds its row lock)
     * @throws ApiException like {@link #persist(PreparedUpload, String, UUID)}
     */
    @Transactional
    public Media persistForPost(PreparedUpload upload, String altText, UUID uploadedBy, UUID postId) {
        return store(upload, altText, uploadedBy, null, postId);
    }

    private Media store(PreparedUpload upload, String altText, UUID uploadedBy, UUID replacing, UUID postId) {
        String alt = normalizeAltText(altText);
        ProcessedImage image = upload.image();
        if (mediaRepository.sumByteSize() - freedBy(replacing) + image.bytes().length > maxTotalBytes) {
            throw new ApiException(
                    ErrorCode.MEDIA_QUOTA_EXCEEDED,
                    HttpStatus.UNPROCESSABLE_CONTENT,
                    "Storing this image would exceed the media storage quota");
        }
        if (!isAdmin(uploadedBy)) {
            requireAuthorShare(uploadedBy, replacing, image.bytes().length);
        }
        Media media = new Media();
        media.setPostId(postId);
        media.setContentType(image.contentType());
        media.setWidth(image.width());
        media.setHeight(image.height());
        media.setByteSize(image.bytes().length);
        media.setSha256(image.sha256());
        media.setDominantColor(image.dominantColor());
        media.setAltText(alt);
        // Sanitize again even though prepare did: PreparedUpload is a public record anyone can construct, and this is
        // idempotent. The column accepts only 255 characters.
        media.setOriginalFilename(cleanOriginalFilename(upload.originalFilename()));
        media.setUploadedBy(uploadedBy);
        Media saved = mediaRepository.save(media);
        mediaContentRepository.save(new MediaContent(saved.getId(), image.bytes()));
        return saved;
    }

    /**
     * The share of an AUTHOR (an ADMIN never gets here): the images this person uploaded may not pass
     * {@code app.author-quota.media-per-author}, and the images of all non-admins together may not pass
     * {@code media-all-authors-percent} of the site quota, so authors can never use the room the ADMIN needs. Like the site
     * quota, read without a lock, and an image that is being replaced counts as already gone.
     */
    private void requireAuthorShare(UUID uploadedBy, UUID replacing, long size) {
        Media old =
                replacing == null ? null : mediaRepository.findById(replacing).orElse(null);
        long freedOwn =
                old != null && uploadedBy != null && uploadedBy.equals(old.getUploadedBy()) ? old.getByteSize() : 0;
        long freedAuthors = old != null && !isAdmin(old.getUploadedBy()) ? old.getByteSize() : 0;
        long mine = uploadedBy == null ? 0 : mediaRepository.sumByteSizeUploadedBy(uploadedBy) - freedOwn;
        if (mine + size > maxAuthorBytes
                || mediaRepository.sumByteSizeUploadedByNonAdmins() - freedAuthors + size > maxTotalAuthorBytes) {
            throw new ApiException(
                    ErrorCode.MEDIA_QUOTA_EXCEEDED,
                    HttpStatus.UNPROCESSABLE_CONTENT,
                    "Storing this image would exceed the share of the media storage quota that authors may use");
        }
    }

    /** Number of bytes given back when the image {@code replacing} is deleted. Reads only the metadata table, never the bytes. */
    private long freedBy(UUID replacing) {
        return replacing == null
                ? 0
                : mediaRepository.findById(replacing).map(Media::getByteSize).orElse(0);
    }

    /**
     * Used image size against the quota: exactly the total that {@link #persist} compares with {@code max-total-size} when
     * accepting a new image, plus the image count. Reads only the metadata table. The two reads are not locked: an upload
     * slipping in between makes the two numbers differ by one image, harmless for a size bar.
     */
    @Transactional(readOnly = true)
    public MediaUsageResponse usage() {
        return new MediaUsageResponse(mediaRepository.sumByteSize(), maxTotalBytes, mediaRepository.count());
    }

    /**
     * Deletes an image; the bytes follow through {@code ON DELETE CASCADE}, and a cover pointing at it becomes null
     * ({@code SET NULL}). Idempotent: an id that no longer exists does nothing, so detaching the same image twice (two
     * admin tabs, repeated clicks) is not an error.
     */
    @Transactional
    public void delete(UUID mediaId) {
        mediaRepository.deleteById(mediaId);
    }

    /**
     * Replaces the alt text. Trim; empty becomes null (clears the alt text).
     *
     * @throws ApiException 400 {@code VALIDATION_ERROR} when longer than 300 characters (checked before the DB lookup, so
     *                      the old value is not touched); 404 {@code MEDIA_NOT_FOUND} when the image does not exist
     */
    @Transactional
    public Media updateAltText(UUID mediaId, String altText) {
        String alt = normalizeAltText(altText);
        Media media = mediaRepository.findById(mediaId).orElseThrow(() -> notFound(mediaId));
        media.setAltText(alt);
        return media;
    }

    /**
     * Image metadata for serving, if and only if {@code extension} matches the stored type: exactly one URL per image,
     * hence exactly one cache key. Reads only the metadata table; the bytes are read separately with {@link #readData}
     * when really needed.
     *
     * @throws ApiException 404 {@code MEDIA_NOT_FOUND} when there is no image or the extension does not match the type
     */
    public Media findForServing(UUID id, String extension) {
        return mediaRepository
                .findById(id)
                .filter(media -> media.extension().equals(extension))
                .orElseThrow(() -> notFound(id));
    }

    /**
     * @throws ApiException 404 {@code MEDIA_NOT_FOUND} when the bytes no longer exist (the image was just deleted between two reads);
     *                      503 {@code MEDIA_BUSY} when {@link #MAX_CONCURRENT_READS} reads are running and none ends within {@link #READ_WAIT}
     */
    public byte[] readData(UUID id) {
        acquire(readPermits, READ_WAIT, "Too many images are being read; try again in a moment");
        try {
            return mediaContentRepository.findDataByMediaId(id).orElseThrow(() -> notFound(id));
        } finally {
            readPermits.release();
        }
    }

    /**
     * The bytes of an image for the owner's own export (a post package, the site export), without the permit that bounds
     * {@link #readData}. That bound protects the heap from a crowd of anonymous readers asking for large pictures; an export is
     * an authenticated, rate-limited request that reads one image at a time. Sharing the permits would let that crowd make
     * an export silently leave its images out (the exports treat any {@link ApiException} as "this image is gone" and keep the
     * reference as written, which breaks on another instance). Never call it for a public request.
     *
     * @throws ApiException 404 {@code MEDIA_NOT_FOUND} when the bytes no longer exist
     */
    public byte[] readDataForExport(UUID id) {
        return mediaContentRepository.findDataByMediaId(id).orElseThrow(() -> notFound(id));
    }

    // --- Normalizing strings sent by the uploader ---------------------------------------------------

    /**
     * Trim; empty becomes null. Length is counted by character (code point) like Postgres VARCHAR(300), not by the UTF-16
     * unit of {@link String#length()}: an emoji is one character in the column.
     *
     * Public so the owner of the image (cover, gallery photo) can call it before {@link #prepare}: an alt text that is too
     * long would fail the request anyway, and should not hold the image-processing slot (semaphore) for several seconds
     * before being rejected. {@link #persist} still normalizes again; this function is idempotent.
     *
     * @throws ApiException 400 {@code VALIDATION_ERROR} when longer than 300 characters
     */
    public static String normalizeAltText(String altText) {
        if (altText == null) {
            return null;
        }
        String stripped = altText.strip();
        if (stripped.isEmpty()) {
            return null;
        }
        if (stripped.codePointCount(0, stripped.length()) > Media.ALT_TEXT_MAX_LENGTH) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.BAD_REQUEST,
                    "altText must be at most " + Media.ALT_TEXT_MAX_LENGTH + " characters");
        }
        return stripped;
    }

    /**
     * The original file name is only there so the admin can recognize their image: keeps the basename (old browsers send
     * the whole path {@code C:\Users\...}), drops control characters (a tab or a delete character renders messily in
     * admin) and invisible or text-direction characters (a right-to-left override makes a name read as another one,
     * {@link UserText#isInvisible}), at most 255 characters, never splitting a surrogate pair. Null when nothing is left.
     */
    static String cleanOriginalFilename(String raw) {
        if (raw == null) {
            return null;
        }
        String basename = raw.substring(Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')) + 1);
        String name = basename.codePoints()
                .filter(codePoint -> !Character.isISOControl(codePoint) && !UserText.isInvisible(codePoint))
                .collect(StringBuilder::new, StringBuilder::appendCodePoint, StringBuilder::append)
                .toString()
                .strip();
        if (name.codePointCount(0, name.length()) > Media.ORIGINAL_FILENAME_MAX_LENGTH) {
            name = name.substring(0, name.offsetByCodePoints(0, Media.ORIGINAL_FILENAME_MAX_LENGTH))
                    .strip();
        }
        return name.isEmpty() ? null : name;
    }

    // --- Helpers ---------------------------------------------------------------------------------

    private void acquireProcessingPermit() {
        acquire(processingPermits, processingWait, "Another image is being processed; try again in a moment");
    }

    /** Waits at most {@code wait} for a permit of {@code permits}; 503 {@code MEDIA_BUSY} with {@code message} otherwise. */
    private static void acquire(Semaphore permits, Duration wait, String message) {
        boolean acquired;
        try {
            acquired = permits.tryAcquire(wait.toNanos(), TimeUnit.NANOSECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            acquired = false;
        }
        if (!acquired) {
            throw new ApiException(ErrorCode.MEDIA_BUSY, HttpStatus.SERVICE_UNAVAILABLE, message);
        }
    }

    private static byte[] readBytes(MultipartFile file) {
        try {
            return file.getBytes();
        } catch (IOException e) {
            // The part was fully received by Tomcat (in memory or /tmp); failing to read it again is a server-side
            // error.
            throw new UncheckedIOException("Reading the uploaded file failed", e);
        }
    }

    private static ApiException notFound(UUID id) {
        return new ApiException(ErrorCode.MEDIA_NOT_FOUND, HttpStatus.NOT_FOUND, "Media not found: " + id);
    }
}
