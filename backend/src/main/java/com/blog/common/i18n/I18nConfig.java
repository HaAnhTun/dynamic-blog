package com.blog.common.i18n;

import java.util.HashMap;
import java.util.Map;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.flyway.autoconfigure.FlywayConfigurationCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;

@Configuration
@EnableConfigurationProperties(I18nProperties.class)
public class I18nConfig {

    /**
     * The {@code defaultLocale} placeholder of V34 comes from the VALIDATED {@code app.i18n} settings, not from the raw
     * environment variable: an empty value falls back to the first locale, upper case is lower-cased, and a code that is not
     * enabled stops the start BEFORE any migration runs. Without this, V34 would commit a bad language into every row and V35
     * would then fail on every start, with a message that does not mention the setting.
     */
    @Bean
    FlywayConfigurationCustomizer defaultLocalePlaceholder(Environment environment) {
        return configuration -> {
            I18nProperties properties = Binder.get(environment)
                    .bind("app.i18n", I18nProperties.class)
                    .orElseGet(() -> new I18nProperties(null, null));
            Map<String, String> placeholders = new HashMap<>(configuration.getPlaceholders());
            placeholders.put("defaultLocale", properties.defaultLocale());
            configuration.placeholders(placeholders);
        };
    }
}
