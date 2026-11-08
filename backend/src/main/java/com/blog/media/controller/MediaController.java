package com.blog.media.controller;

import com.blog.media.entity.Media;
import com.blog.media.service.MediaService;
import java.time.Duration;
import java.util.UUID;
import lombok.RequiredArgsConstructor;
import org.springframework.http.CacheControl;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.context.request.WebRequest;

/**
 * Serves the bytes of an image, publicly. The browser does not call this: the Next {@code /media/[file]} route
 * calls it, and {@code /_next/image} optimizes further.
 *
 * Images are "unlisted, not private": anyone with the URL can download them, including the cover of a draft post and
 * hidden gallery photos. There is no permission check here, and that is deliberate.
 */
@RestController
@RequestMapping("/api/v1/media")
@RequiredArgsConstructor
public class MediaController {

    /**
     * A URL never changes content (a new image gets a new UUID), so it can be cached forever. Setting this header
     * also stops Spring Security from inserting its default no-cache/no-store.
     */
    private static final CacheControl IMMUTABLE =
            CacheControl.maxAge(Duration.ofDays(365)).cachePublic().immutable();

    private final MediaService mediaService;

    /**
     * The extension is pinned by regex (exactly {@code jpg} or {@code png}, case-sensitive) and must match the stored
     * type: one URL per image. Another extension matches no route (404 {@code ENDPOINT_NOT_FOUND}); a well-formed
     * extension with the wrong type is 404 {@code MEDIA_NOT_FOUND}; an id that is not a UUID is 400.
     *
     * The order is the whole point: look up the metadata (a small row) and answer 304 when {@code If-None-Match}
     * matches, BEFORE reading up to 4 MB of bytes. Browsers and the Next cache mostly just revalidate, and that
     * answer never touches the bytes table.
     */
    @GetMapping("/{id}.{ext:jpg|png}")
    public ResponseEntity<byte[]> serve(@PathVariable UUID id, @PathVariable String ext, WebRequest request) {
        Media media = mediaService.findForServing(id, ext);
        // Strong ETag: the sha256 of exactly the bytes being served.
        String etag = "\"" + media.getSha256() + "\"";
        if (request.checkNotModified(etag)) {
            // checkNotModified already set 304 and the ETag; RFC 9110 section 15.4.5 requires a 304 to also carry the
            // Cache-Control that the 200 would have sent, so the cache extends the copy it holds instead of treating it
            // as expired.
            return ResponseEntity.status(HttpStatus.NOT_MODIFIED)
                    .cacheControl(IMMUTABLE)
                    .build();
        }
        byte[] data = mediaService.readData(id);
        return ResponseEntity.ok()
                // Taken from the stored type (only jpeg/png, the V11 CHECK), never from what the client declared at
                // upload.
                .contentType(MediaType.parseMediaType(media.getContentType()))
                .contentLength(data.length)
                .eTag(etag)
                .cacheControl(IMMUTABLE)
                .body(data);
    }
}
