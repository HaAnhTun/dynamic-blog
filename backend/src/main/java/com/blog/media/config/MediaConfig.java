package com.blog.media.config;

import com.blog.media.service.ImageProcessor;
import jakarta.annotation.PostConstruct;
import javax.imageio.ImageIO;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
@EnableConfigurationProperties(MediaProperties.class)
public class MediaConfig {

    /**
     * Runs once at startup, on the main thread.
     *
     * - {@code setUseCache(false)}: by default ImageIO wraps every InputStream with a temp file on disk.
     *   The image is already in memory (at most 10 MB), so the temp file only adds I/O, and the container can write only /tmp.
     * - {@code scanForPlugins()}: in the fat jar, the TwelveMonkeys plugins live in BOOT-INF/lib and only the Boot class
     *   loader (the context class loader of the main thread at this point) can see them. Scanning explicitly here
     *   keeps registration from depending on which thread happens to touch ImageIO first.
     * - Startup fails when the WebP reader is missing: without it, every WebP image would become a 415 at upload time, an
     *   error that only surfaces when a real user hits it.
     */
    @PostConstruct
    void registerImagePlugins() {
        ImageIO.setUseCache(false);
        ImageIO.scanForPlugins();
        requireReader("webp");
    }

    /** Package-visible and static so the rule can be tested without removing a plugin from the shared registry. */
    static void requireReader(String formatName) {
        if (!ImageIO.getImageReadersByFormatName(formatName).hasNext()) {
            throw new IllegalStateException("No ImageIO reader registered for '" + formatName
                    + "'; is the TwelveMonkeys imageio-" + formatName + " plugin on the classpath?");
        }
    }

    @Bean
    ImageProcessor imageProcessor(MediaProperties properties) {
        return new ImageProcessor(properties);
    }
}
