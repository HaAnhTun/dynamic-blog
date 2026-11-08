package com.blog.media.service;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;

/**
 * A cheap structural check of an ICC profile that an uploader embedded in an image, made BEFORE the bytes reach the JDK's Little CMS
 * (native code in the process that holds the database credentials and the signing key). A profile that fails it is treated as absent,
 * like any damaged metadata: the image is read as sRGB. It checks what a real RGB display, input, output or colour-space profile
 * always has and what a forged one often does not: the {@code acsp} signature, a device class and an RGB colour space the pipeline
 * can use, a declared size that fits the data, a tag count that is bounded, and every tag inside the declared size. It is not a
 * validator of the profile (LCMS still parses what passes), only a narrowing of what it is shown.
 */
final class IccProfileHeader {

    private static final int HEADER_BYTES = 128;
    private static final int TAG_COUNT_AT = 128;
    private static final int TAG_TABLE_AT = 132;
    private static final int TAG_ENTRY_BYTES = 12;
    /** A real profile has a few dozen tags; more than this is not an image profile. */
    private static final int MAX_TAGS = 100;

    private IccProfileHeader() {}

    static boolean plausible(byte[] data) {
        if (data == null || data.length < TAG_TABLE_AT) {
            return false;
        }
        ByteBuffer buffer = ByteBuffer.wrap(data);
        long declared = Integer.toUnsignedLong(buffer.getInt(0));
        if (declared < TAG_TABLE_AT || declared > data.length) {
            return false;
        }
        if (!"acsp".equals(ascii(data, 36)) || !"RGB ".equals(ascii(data, 16))) {
            return false;
        }
        String deviceClass = ascii(data, 12);
        if (!"mntr".equals(deviceClass)
                && !"scnr".equals(deviceClass)
                && !"prtr".equals(deviceClass)
                && !"spac".equals(deviceClass)) {
            return false;
        }
        long tags = Integer.toUnsignedLong(buffer.getInt(TAG_COUNT_AT));
        if (tags > MAX_TAGS || TAG_TABLE_AT + tags * TAG_ENTRY_BYTES > declared) {
            return false;
        }
        for (int i = 0; i < tags; i++) {
            int entry = TAG_TABLE_AT + i * TAG_ENTRY_BYTES;
            long offset = Integer.toUnsignedLong(buffer.getInt(entry + 4));
            long size = Integer.toUnsignedLong(buffer.getInt(entry + 8));
            if (offset < HEADER_BYTES || offset + size > declared) {
                return false;
            }
        }
        return true;
    }

    private static String ascii(byte[] data, int at) {
        return new String(data, at, 4, StandardCharsets.US_ASCII);
    }
}
