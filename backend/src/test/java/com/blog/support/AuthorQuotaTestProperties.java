package com.blog.support;

import com.blog.common.quota.AuthorQuotaProperties;
import java.util.HashMap;
import java.util.Map;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.context.properties.source.MapConfigurationPropertySource;

/**
 * {@link AuthorQuotaProperties} for unit tests, built the way the application builds them: bound from
 * {@code app.author-quota.*}, so every key that is not given has its real default and a test overrides only the limit it
 * cares about, by the same key an operator would use.
 */
public final class AuthorQuotaTestProperties {

    private AuthorQuotaTestProperties() {}

    /** The defaults of the application. */
    public static AuthorQuotaProperties defaults() {
        return with(Map.of());
    }

    /**
     * The defaults with some keys set.
     *
     * @param overrides keys relative to {@code app.author-quota}, for example {@code max-tags-per-post -> "2"}
     */
    public static AuthorQuotaProperties with(Map<String, String> overrides) {
        Map<String, Object> keys = new HashMap<>();
        overrides.forEach((key, value) -> keys.put("app.author-quota." + key, value));
        return new Binder(new MapConfigurationPropertySource(keys))
                .bindOrCreate("app.author-quota", AuthorQuotaProperties.class);
    }
}
