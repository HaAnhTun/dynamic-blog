package com.blog.media.service;

/**
 * An image that is fully processed but NOT yet stored: the result of {@link MediaService#prepare}, which runs outside a
 * transaction. The two steps are split so the time-consuming part (decode, downscale, encode) does not hold a DB connection.
 *
 * @param originalFilename the original file name, sanitized (basename only, no control characters, at most 255
 *                         characters); null when the client sent no name
 */
public record PreparedUpload(ProcessedImage image, String originalFilename) {}
