package com.blog.media.service;

import static org.assertj.core.api.Assertions.assertThat;

import java.awt.color.ColorSpace;
import java.awt.color.ICC_Profile;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.junit.jupiter.api.Test;

/** The structural check made before an embedded ICC profile reaches the JDK's native colour engine. */
class IccProfileHeaderTest {

    private static byte[] linearRgb() {
        return ICC_Profile.getInstance(ColorSpace.CS_LINEAR_RGB).getData();
    }

    private static byte[] with(byte[] profile, int at, String ascii) {
        byte[] copy = profile.clone();
        byte[] text = ascii.getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(text, 0, copy, at, text.length);
        return copy;
    }

    private static byte[] withInt(byte[] profile, int at, long value) {
        byte[] copy = profile.clone();
        ByteBuffer.wrap(copy).putInt(at, (int) value);
        return copy;
    }

    @Test
    void a_real_rgb_profile_passes() {
        assertThat(IccProfileHeader.plausible(linearRgb())).isTrue();
        assertThat(IccProfileHeader.plausible(
                        ICC_Profile.getInstance(ColorSpace.CS_sRGB).getData()))
                .isTrue();
    }

    @Test
    void a_profile_that_is_not_shaped_like_an_rgb_image_profile_is_refused() {
        byte[] good = linearRgb();

        assertThat(IccProfileHeader.plausible(null)).isFalse();
        assertThat(IccProfileHeader.plausible(new byte[0])).isFalse();
        assertThat(IccProfileHeader.plausible(Arrays.copyOf(good, 131))).isFalse();
        // The signature, the colour space and the device class.
        assertThat(IccProfileHeader.plausible(with(good, 36, "xxxx"))).isFalse();
        assertThat(IccProfileHeader.plausible(with(good, 16, "CMYK"))).isFalse();
        assertThat(IccProfileHeader.plausible(with(good, 16, "GRAY"))).isFalse();
        assertThat(IccProfileHeader.plausible(with(good, 12, "link"))).isFalse();
        assertThat(IccProfileHeader.plausible(with(good, 12, "abst"))).isFalse();
        // A declared size that does not fit the data, or is smaller than a header.
        assertThat(IccProfileHeader.plausible(withInt(good, 0, good.length + 1L)))
                .isFalse();
        assertThat(IccProfileHeader.plausible(withInt(good, 0, 0xFFFFFFFFL))).isFalse();
        assertThat(IccProfileHeader.plausible(withInt(good, 0, 100))).isFalse();
    }

    @Test
    void a_huge_tag_count_or_a_tag_outside_the_profile_is_refused() {
        byte[] good = linearRgb();

        assertThat(IccProfileHeader.plausible(withInt(good, 128, 101))).isFalse();
        assertThat(IccProfileHeader.plausible(withInt(good, 128, 0xFFFFFFFFL))).isFalse();
        // The first tag points past the end, and another has a size that wraps.
        assertThat(IccProfileHeader.plausible(withInt(good, 132 + 4, good.length)))
                .isFalse();
        assertThat(IccProfileHeader.plausible(withInt(good, 132 + 8, 0xFFFFFFF0L)))
                .isFalse();
        assertThat(IccProfileHeader.plausible(withInt(good, 132 + 4, 10))).isFalse();
    }
}
