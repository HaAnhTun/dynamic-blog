package com.blog.gallery.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.gallery.dto.GalleryPhotoAdminResponse;
import com.blog.gallery.dto.GalleryPhotoResponse;
import com.blog.gallery.dto.GalleryPhotoUpdateRequest;
import com.blog.gallery.entity.GalleryPhoto;
import com.blog.gallery.repository.GalleryPhotoRepository;
import com.blog.media.entity.Media;
import com.blog.media.mapper.MediaMapper;
import com.blog.media.service.MediaService;
import com.blog.media.service.PreparedUpload;
import java.time.LocalDate;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Sort;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.multipart.MultipartFile;

/**
 * The site owner's photo gallery: public listing and administration (ADMIN only, URL rule).
 *
 * A gallery photo is created only here, together with its image (Media), and the image belongs to exactly that gallery
 * photo: deleting a gallery photo deletes the image too, so there are no orphan images.
 *
 * No class-level {@code @Transactional}: upload processes the image (a few hundred ms to a few seconds) OUTSIDE a
 * transaction, as {@link MediaService#prepare} requires, and only then opens a short transaction to store the image and
 * create the gallery photo; the two commit or roll back together. Every DTO is mapped inside the transaction (the
 * relation to the image is LAZY, open-in-view is off).
 */
@Service
public class GalleryService {

    /**
     * Display order, shared by the public page and the admin screen, so the order the site owner arranged is the order
     * readers see. Same order as the index idx_gallery_photos_published_order (V17).
     */
    private static final Sort DISPLAY_ORDER = Sort.by(Sort.Order.asc("sortOrder"), Sort.Order.desc("createdAt"));

    private static final int MAX_PAGE_SIZE = 100;
    /** The largest page for which the start offset (page x size) still fits an int, the type JPA uses for that offset. */
    private static final int MAX_PAGE = Integer.MAX_VALUE / MAX_PAGE_SIZE;

    private final GalleryPhotoRepository galleryPhotoRepository;
    private final MediaService mediaService;
    private final TransactionTemplate transactionTemplate;

    public GalleryService(
            GalleryPhotoRepository galleryPhotoRepository,
            MediaService mediaService,
            PlatformTransactionManager transactionManager) {
        this.galleryPhotoRepository = galleryPhotoRepository;
        this.mediaService = mediaService;
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    // --- Public --------------------------------------------------------------------------------------------

    /**
     * Visible photos in the arranged order; {@code size} is clamped to 1..100 and {@code page} to 0..21474836: a negative
     * page becomes the first page, an oversized page becomes an empty page rather than a 500.
     */
    @Transactional(readOnly = true)
    public Page<GalleryPhotoResponse> listPublished(int page, int size) {
        PageRequest pageable =
                PageRequest.of(Math.clamp(page, 0, MAX_PAGE), Math.clamp(size, 1, MAX_PAGE_SIZE), DISPLAY_ORDER);
        return galleryPhotoRepository.findByPublishedTrue(pageable).map(GalleryService::toResponse);
    }

    // --- Admin ---------------------------------------------------------------------------------------------

    /** All photos, hidden ones included, unpaged: reordering must send a permutation of this whole list. */
    @Transactional(readOnly = true)
    public List<GalleryPhotoAdminResponse> listAll() {
        return galleryPhotoRepository.findAll(DISPLAY_ORDER).stream()
                .map(GalleryService::toAdminResponse)
                .toList();
    }

    /**
     * Processes the image, stores it, then creates the gallery photo at the top of the list: the site owner who just
     * uploaded wants to see that photo first.
     *
     * @param takenOn   date taken as entered by the uploader; when null, uses DateTimeOriginal from the EXIF of the
     *                  original file (a date in camera local time, no time zone), and null if that is missing too
     * @param published null means visible: a photo just uploaded with no other instruction is meant to be shown
     * @throws ApiException 400 {@code VALIDATION_ERROR} when the caption exceeds 1000 characters or the alt text exceeds
     *                      300 characters (both checked before the costly image processing); every error of
     *                      {@link MediaService#prepare} and {@link MediaService#persist} (400, 413, 415, 422, 503), in
     *                      which case nothing is stored
     */
    public GalleryPhotoAdminResponse upload(
            MultipartFile file, String caption, String altText, LocalDate takenOn, Boolean published, UUID uploader) {
        String cleanCaption = normalizeCaption(caption);
        // Check only: persist normalizes again when storing. Checked here so a request that will fail anyway does not
        // hold
        // the server's single image-processing slot for several seconds.
        MediaService.normalizeAltText(altText);
        PreparedUpload prepared = mediaService.prepare(file);
        return transactionTemplate.execute(status -> {
            Media media = mediaService.persist(prepared, altText, uploader);
            GalleryPhoto photo = new GalleryPhoto();
            photo.setMedia(media);
            photo.setCaption(cleanCaption);
            photo.setTakenOn(takenOn != null ? takenOn : prepared.image().takenOn());
            photo.setPublished(published == null || published);
            photo.setSortOrder(galleryPhotoRepository.nextTopSortOrder());
            return toAdminResponse(galleryPhotoRepository.saveAndFlush(photo));
        });
    }

    /**
     * Replaces the whole caption, alt text, taken-on date and visibility flag; null or a blank string clears the old
     * value. The image and the order do not change. If any field is invalid, no field is written.
     *
     * @throws ApiException 400 {@code VALIDATION_ERROR} when the caption exceeds 1000 or the alt text exceeds 300
     *                      characters; 404 {@code GALLERY_PHOTO_NOT_FOUND}
     */
    @Transactional
    public GalleryPhotoAdminResponse update(UUID id, GalleryPhotoUpdateRequest request) {
        String caption = normalizeCaption(request.caption());
        GalleryPhoto photo = galleryPhotoRepository.findByIdForUpdate(id).orElseThrow(() -> notFound(id));
        // The alt text lives on the image (media table), sharing the trim and length rules with the cover image. The id
        // is read from the LAZY proxy.
        mediaService.updateAltText(photo.getMedia().getId(), request.altText());
        photo.setCaption(caption);
        photo.setTakenOn(request.takenOn());
        photo.setPublished(request.published());
        // An edit is an edit of the photo, even when only the alt text (in another table) changed: without this line
        // this
        // row is not dirty, Hibernate does not write it, and updatedAt stays put.
        photo.setUpdatedAt(GalleryPhoto.now());
        // Flush now: @PreUpdate sets updatedAt at flush time, and the response must carry the value the DB just stored.
        return toAdminResponse(galleryPhotoRepository.saveAndFlush(photo));
    }

    /**
     * Deletes the gallery photo together with its image; the bytes follow through {@code ON DELETE CASCADE} (V11).
     *
     * The gallery row is deleted first, then the image: like deleting a post together with its cover image
     * (PostService.delete). Deleting the image would also take the gallery row through the foreign key, but the entity
     * managed in this transaction would still point at a deleted image.
     *
     * @throws ApiException 404 {@code GALLERY_PHOTO_NOT_FOUND}, also when another delete has just removed this photo
     */
    @Transactional
    public void delete(UUID id) {
        GalleryPhoto photo = galleryPhotoRepository.findByIdForUpdate(id).orElseThrow(() -> notFound(id));
        UUID mediaId = photo.getMedia().getId();
        galleryPhotoRepository.delete(photo);
        mediaService.delete(mediaId);
    }

    /**
     * Writes the new order: the i-th photo in the list gets order i. The list must be an exact permutation of ALL
     * photos: a stale tab that has not seen a photo just uploaded in another tab is rejected (the UI tells the user to
     * reload the page), instead of guessing a position for a photo it does not know.
     *
     * One transaction, under the write lock of every photo ({@link GalleryPhotoRepository#findAllForUpdate}): the list
     * that is checked is exactly the list that is written. Does not touch {@code updatedAt}: reordering is not editing a
     * photo.
     *
     * @return all photos in the new order
     * @throws ApiException 400 {@code VALIDATION_ERROR} when the list has duplicate ids or is missing photos;
     *                      400 {@code GALLERY_PHOTO_NOT_FOUND} when an id is not any photo (the id is in the request
     *                      body, not in the path, so it is a 400 and not a 404)
     */
    @Transactional
    public List<GalleryPhotoAdminResponse> reorder(List<UUID> photoIds) {
        if (new HashSet<>(photoIds).size() < photoIds.size()) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, "photoIds must not contain duplicates");
        }
        Set<UUID> current = galleryPhotoRepository.findAllForUpdate().stream()
                .map(GalleryPhoto::getId)
                .collect(Collectors.toSet());
        for (UUID photoId : photoIds) {
            if (!current.contains(photoId)) {
                throw new ApiException(
                        ErrorCode.GALLERY_PHOTO_NOT_FOUND,
                        HttpStatus.BAD_REQUEST,
                        "Gallery photo not found: " + photoId);
            }
        }
        // No duplicates and all real, so the right count means every photo is present.
        if (photoIds.size() != current.size()) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.BAD_REQUEST,
                    "photoIds must list every gallery photo exactly once: expected " + current.size() + ", got "
                            + photoIds.size());
        }
        for (int i = 0; i < photoIds.size(); i++) {
            galleryPhotoRepository.setSortOrder(photoIds.get(i), i + 1);
        }
        // setSortOrder clears the persistence context, so the list is reloaded with the new order.
        return listAll();
    }

    // --- Mapping and normalization -------------------------------------------------------------------------

    private static GalleryPhotoResponse toResponse(GalleryPhoto photo) {
        return new GalleryPhotoResponse(
                photo.getId(), MediaMapper.toResponse(photo.getMedia()), photo.getCaption(), photo.getTakenOn());
    }

    private static GalleryPhotoAdminResponse toAdminResponse(GalleryPhoto photo) {
        Media media = photo.getMedia();
        return new GalleryPhotoAdminResponse(
                photo.getId(),
                MediaMapper.toResponse(media),
                photo.getCaption(),
                photo.getTakenOn(),
                photo.isPublished(),
                photo.getSortOrder(),
                media.getOriginalFilename(),
                media.getByteSize(),
                photo.getCreatedAt(),
                photo.getUpdatedAt());
    }

    /**
     * Trim; empty becomes null (the UI hides a field that was not filled in, and "" would render as an empty caption
     * line). Length is counted by character (code point) like the alt text in MediaService, not by UTF-16 unit: an emoji
     * is one character.
     */
    private static String normalizeCaption(String caption) {
        if (caption == null) {
            return null;
        }
        String stripped = caption.strip();
        if (stripped.isEmpty()) {
            return null;
        }
        if (stripped.codePointCount(0, stripped.length()) > GalleryPhoto.CAPTION_MAX_LENGTH) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.BAD_REQUEST,
                    "caption must be at most " + GalleryPhoto.CAPTION_MAX_LENGTH + " characters");
        }
        return stripped;
    }

    private static ApiException notFound(UUID id) {
        return new ApiException(
                ErrorCode.GALLERY_PHOTO_NOT_FOUND, HttpStatus.NOT_FOUND, "Gallery photo not found: " + id);
    }
}
