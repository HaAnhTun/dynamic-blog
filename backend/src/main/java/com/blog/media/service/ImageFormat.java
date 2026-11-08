package com.blog.media.service;

import java.util.Optional;

/**
 * The three ACCEPTED formats, identified by magic bytes and not by the file extension or the Content-Type that the
 * client declares (both are set by the client itself). GIF, SVG, HEIC, AVIF, BMP and TIFF match nothing and are rejected.
 */
public enum ImageFormat {
    JPEG("jpeg"),
    PNG("png"),
    WEBP("webp");

    private static final byte[] JPEG_MAGIC = {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF};
    private static final byte[] PNG_MAGIC = {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};
    private static final byte[] RIFF = {'R', 'I', 'F', 'F'};
    private static final byte[] WEBP_FOURCC = {'W', 'E', 'B', 'P'};

    private final String readerFormatName;

    ImageFormat(String readerFormatName) {
        this.readerFormatName = readerFormatName;
    }

    /** Name used to ask ImageIO for the right reader for the sniffed format, instead of letting ImageIO guess. */
    public String readerFormatName() {
        return readerFormatName;
    }

    /**
     * The format of the data judging by the first few bytes: JPEG {@code FF D8 FF}, PNG {@code 89 50 4E 47 0D 0A 1A 0A},
     * WebP {@code RIFF????WEBP}. Empty when no format matches.
     */
    public static Optional<ImageFormat> sniff(byte[] head) {
        if (head == null) {
            return Optional.empty();
        }
        if (startsWith(head, 0, JPEG_MAGIC)) {
            return Optional.of(JPEG);
        }
        if (startsWith(head, 0, PNG_MAGIC)) {
            return Optional.of(PNG);
        }
        // RIFF is the shared container of WAV, AVI and more; only the fourCC at bytes 8-11 says this is WebP.
        if (startsWith(head, 0, RIFF) && startsWith(head, 8, WEBP_FOURCC)) {
            return Optional.of(WEBP);
        }
        return Optional.empty();
    }

    private static boolean startsWith(byte[] data, int offset, byte[] prefix) {
        if (data.length < offset + prefix.length) {
            return false;
        }
        for (int i = 0; i < prefix.length; i++) {
            if (data[offset + i] != prefix[i]) {
                return false;
            }
        }
        return true;
    }
}
