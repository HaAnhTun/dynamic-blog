package com.blog.common.i18n;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.util.List;
import java.util.Locale;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/** The one place that decides whether a language code is enabled; every {@code lang} parameter and every body field goes through it. */
@Component
public class Languages {

    private final I18nProperties properties;

    public Languages(I18nProperties properties) {
        this.properties = properties;
    }

    public String defaultLocale() {
        return properties.defaultLocale();
    }

    public List<String> enabled() {
        return properties.locales();
    }

    public boolean isEnabled(String language) {
        return language != null && properties.locales().contains(language);
    }

    /** A request parameter: absent or blank means "no language filter" (null); anything else must be an enabled locale. */
    public String optional(String language) {
        if (language == null || language.isBlank()) {
            return null;
        }
        return require(language);
    }

    /** A body field: the code, normalised to lower case; 400 {@code VALIDATION_ERROR} when it is not enabled. */
    public String require(String language) {
        String code = language == null ? "" : language.strip().toLowerCase(Locale.ROOT);
        if (!isEnabled(code)) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.BAD_REQUEST,
                    "language must be one of " + String.join(", ", properties.locales()));
        }
        return code;
    }

    /** The language of a post created without one. */
    public String orDefault(String language) {
        return language == null || language.isBlank() ? properties.defaultLocale() : require(language);
    }
}
