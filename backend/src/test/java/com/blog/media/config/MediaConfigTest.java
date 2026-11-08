package com.blog.media.config;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.media.service.ImageProcessor;
import java.time.Duration;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.servlet.autoconfigure.MultipartProperties;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.boot.tomcat.autoconfigure.TomcatServerProperties;
import org.springframework.util.unit.DataSize;

/**
 * The configuration side of the image pipeline: the real application.yml (loaded through ConfigData as at runtime), the real MediaConfig,
 * but no web layer or DB, so it does not cost another Testcontainers context.
 */
class MediaConfigTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withInitializer(new ConfigDataApplicationContextInitializer())
            .withUserConfiguration(MediaConfig.class);

    @Test
    void application_yml_sets_the_expected_media_limits() {
        runner.run(context -> {
            assertThat(context).hasNotFailed();
            MediaProperties media = context.getBean(MediaProperties.class);
            assertThat(media.maxUploadSize()).isEqualTo(DataSize.ofMegabytes(10));
            // 4 MiB = 4,194,304 bytes: exactly the CHECK ceiling on byte_size of the media table (V11).
            assertThat(media.maxStoredSize().toBytes()).isEqualTo(4_194_304L);
            assertThat(media.maxPixels()).isEqualTo(50_000_000L);
            assertThat(media.maxEdge()).isEqualTo(2400);
            assertThat(media.jpegQuality()).isEqualTo(0.92f);
            if (System.getenv("MEDIA_MAX_TOTAL_SIZE") == null) {
                assertThat(media.maxTotalSize()).isEqualTo(DataSize.ofGigabytes(1));
            }
            assertThat(media.processingPermits()).isEqualTo(1);
            assertThat(media.processingWait()).isEqualTo(Duration.ofSeconds(20));
            assertThat(context).hasSingleBean(ImageProcessor.class);
        });
    }

    @Test
    void multipart_and_tomcat_keys_are_spelled_correctly_so_boot_really_applies_them() {
        // Mistyping one key makes Boot silently keep the default (1MB / 10MB / 2MB). Bind into Boot's own properties
        // class
        // and compare with the wanted values; since the defaults differ from the needed values, a wrong key turns the
        // test red.
        runner.run(context -> {
            Binder binder = Binder.get(context.getEnvironment());
            MultipartProperties multipart = binder.bind("spring.servlet.multipart", MultipartProperties.class)
                    .get();
            assertThat(multipart.getMaxFileSize()).isEqualTo(DataSize.ofMegabytes(10));
            assertThat(multipart.getMaxRequestSize()).isEqualTo(DataSize.ofMegabytes(11));
            TomcatServerProperties tomcat =
                    binder.bind("server.tomcat", TomcatServerProperties.class).get();
            assertThat(tomcat.getMaxSwallowSize()).isEqualTo(DataSize.ofMegabytes(32));
        });
    }

    @Test
    void startup_turns_off_imageio_disk_cache() {
        // This flag is global state of the JVM running the tests; restore it so the test order does not matter.
        boolean before = ImageIO.getUseCache();
        ImageIO.setUseCache(true); // the JDK default: one temp file for each stream made from an InputStream
        try {
            runner.run(context -> {
                assertThat(context).hasNotFailed();
                assertThat(ImageIO.getUseCache()).isFalse();
            });
        } finally {
            ImageIO.setUseCache(before);
        }
    }

    @Test
    void missing_reader_for_a_format_stops_the_application_from_starting() {
        assertThatThrownBy(() -> MediaConfig.requireReader("khong-co-dinh-dang-nay"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("khong-co-dinh-dang-nay");
        // Positive control: with imageio-webp on the classpath this check passes.
        assertThatCode(() -> MediaConfig.requireReader("webp")).doesNotThrowAnyException();
    }

    @Test
    void absurd_configuration_stops_the_application_from_starting() {
        // 85 instead of 0.85 is an easy typo; if it slipped through, ImageWriteParam would only throw at the first
        // upload, as a 500.
        runner.withPropertyValues("app.media.jpeg-quality=85")
                .run(context ->
                        assertThat(context).hasFailed().getFailure().rootCause().hasMessageContaining("jpegQuality"));
        runner.withPropertyValues("app.media.processing-permits=0")
                .run(context -> assertThat(context)
                        .hasFailed()
                        .getFailure()
                        .rootCause()
                        .hasMessageContaining("processingPermits"));
    }
}
