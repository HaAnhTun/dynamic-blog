package com.blog.media.repository;

import com.blog.media.entity.Media;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface MediaRepository extends JpaRepository<Media, UUID> {

    /**
     * Total bytes of all stored images, for the quota {@code app.media.max-total-size}. Reads the byte_size column of the
     * metadata table and never touches the bytes table.
     */
    @Query("select coalesce(sum(m.byteSize), 0) from Media m")
    long sumByteSize();

    /**
     * Stored bytes of the images this person uploaded (covers and body images), for the share of an AUTHOR. Reads the metadata
     * table only.
     */
    @Query("select coalesce(sum(m.byteSize), 0) from Media m where m.uploadedBy = :uploader")
    long sumByteSizeUploadedBy(UUID uploader);

    /**
     * Stored bytes of the images uploaded by anyone who is not an ADMIN (and by nobody known, whose rows lost their uploader),
     * for the share that all AUTHORS together may use.
     */
    @Query(value = """
            select coalesce(sum(m.byte_size), 0) from media m
            where m.uploaded_by is null
               or m.uploaded_by not in (select u.id from users u where u.role = 'ADMIN')""", nativeQuery = true)
    long sumByteSizeUploadedByNonAdmins();

    /** The role of an account, as text; empty when there is no such account. For the limits that an ADMIN is exempt from. */
    @Query(value = "select u.role from users u where u.id = :id", nativeQuery = true)
    Optional<String> findRoleOfUser(UUID id);

    /** Images in the body of one post. */
    long countByPostId(UUID postId);

    /**
     * Images in the body of a post, newest first; at the same instant the id decides, so the order does not flip between
     * two reads. Only images whose {@code post_id} is this post: covers and gallery photos are never included (index idx_media_post_id).
     */
    List<Media> findAllByPostIdOrderByCreatedAtDescIdDesc(UUID postId);

    /**
     * A body image of this post that holds exactly these (processed) bytes, by their SHA-256: what an import looks for before it
     * stores an image again (index idx_media_post_id). Covers and gallery photos have no {@code post_id}, so they never match.
     */
    Optional<Media> findFirstByPostIdAndSha256(UUID postId, String sha256);

    /**
     * One of these images (the ones the stored About content already uses) that holds exactly these (processed) bytes: what
     * the site profile import looks for before it stores an image again. Limited to those ids, so an import never shares a
     * row with the avatar, a cover or a gallery photo, whose deletion would then take the About image with it.
     */
    Optional<Media> findFirstByIdInAndSha256(Collection<UUID> ids, String sha256);

    /** An image if and only if it is a body image of exactly this post; empty for covers, gallery photos and images of other posts. */
    Optional<Media> findByIdAndPostId(UUID id, UUID postId);
}
