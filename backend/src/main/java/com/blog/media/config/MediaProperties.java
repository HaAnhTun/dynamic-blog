package com.blog.media.config;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.util.unit.DataSize;

/**
 * Limits of the image pipeline, bound from {@code app.media.*} (application.yml).
 *
 * No {@code @DefaultValue}: application.yml always sets this whole block, and a second copy of the values
 * here would only drift apart. Instead the constructor rejects nonsensical values, so a wrong configuration stops the
 * application from starting, rather than waiting for the first upload to throw a 500 (for example a jpeg-quality of 85
 * instead of 0.85 would only blow up inside ImageWriteParam).
 *
 * @param maxUploadSize     maximum bytes of the uploaded file, checked in code (MediaService)
 * @param maxStoredSize     ceiling per image AFTER processing; matches the CHECK on byte_size of the media table
 * @param maxPixels         maximum width x height, read from the header before decoding
 * @param maxEdge           maximum long edge of the stored image
 * @param jpegQuality       output JPEG quality, in (0, 1]
 * @param maxTotalSize      total size of stored images (quota)
 * @param processingPermits number of images processed at the same time
 * @param processingWait    how long to wait for a permit before returning MEDIA_BUSY
 */
@ConfigurationProperties("app.media")
public record MediaProperties(
        DataSize maxUploadSize,
        DataSize maxStoredSize,
        long maxPixels,
        int maxEdge,
        float jpegQuality,
        DataSize maxTotalSize,
        int processingPermits,
        Duration processingWait) {

    public MediaProperties {
        requirePositive("maxUploadSize", maxUploadSize);
        requirePositive("maxStoredSize", maxStoredSize);
        requirePositive("maxTotalSize", maxTotalSize);
        require(maxPixels > 0, "maxPixels", maxPixels);
        require(maxEdge > 0, "maxEdge", maxEdge);
        require(jpegQuality > 0f && jpegQuality <= 1f, "jpegQuality", jpegQuality + " (must be in (0, 1])");
        require(processingPermits > 0, "processingPermits", processingPermits);
        require(processingWait != null && !processingWait.isNegative(), "processingWait", processingWait);
    }

    private static void requirePositive(String name, DataSize size) {
        require(size != null && size.toBytes() > 0, name, size);
    }

    private static void require(boolean ok, String name, Object value) {
        if (!ok) {
            throw new IllegalArgumentException("app.media." + name + " is invalid: " + value);
        }
    }
}
