package com.blog.media.repository;

import com.blog.media.entity.MediaContent;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface MediaContentRepository extends JpaRepository<MediaContent, UUID> {

    /**
     * Only the byte array, through a projection: no managed entity, so Hibernate keeps no snapshot copy
     * (up to 4 MB extra each time an image is served). Empty when the bytes no longer exist, even if the metadata does.
     */
    @Query("select c.data from MediaContent c where c.mediaId = :mediaId")
    Optional<byte[]> findDataByMediaId(UUID mediaId);
}
