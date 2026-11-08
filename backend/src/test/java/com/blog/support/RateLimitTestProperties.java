package com.blog.support;

import com.blog.common.ratelimit.RateLimitProperties;
import java.util.Map;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;

/**
 * {@link RateLimitProperties} for unit tests, built the way the application builds them: bound from {@code app.rate-limit.*}, so
 * every key that is not given has its real default, and a test overrides only the limit it cares about, by the same key
 * an operator would use.
 */
public final class RateLimitTestProperties {

    private RateLimitTestProperties() {}

    /** The defaults of the application. */
    public static RateLimitProperties defaults() {
        return with(Map.of());
    }

    /**
     * The defaults with some keys set.
     *
     * @param overrides keys relative to {@code app.rate-limit}, for example {@code contact-global.per-hour -> "3"}
     */
    public static RateLimitProperties with(Map<String, String> overrides) {
        Map<String, Object> keys = new java.util.HashMap<>();
        overrides.forEach((key, value) -> keys.put("app.rate-limit." + key, value));
        return new Binder(new MapConfigurationPropertySource(keys))
                .bindOrCreate("app.rate-limit", RateLimitProperties.class);
    }
}
