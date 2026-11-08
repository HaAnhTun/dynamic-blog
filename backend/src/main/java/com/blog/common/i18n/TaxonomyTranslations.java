package com.blog.common.i18n;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.text.SingleLine;
import com.blog.common.text.UserText;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * Validates and normalises the {@code translations} of a category, tag or series request. A translated name is one line
 * of text, like the base name ({@link SingleLine}); a description may have several lines.
 */
@Component
public class TaxonomyTranslations {

    private static final Pattern ONE_LINE = Pattern.compile(SingleLine.REGEXP);

    private final Languages languages;

    public TaxonomyTranslations(Languages languages) {
        this.languages = languages;
    }

    /**
     * Keys must be enabled locales (400 otherwise), texts are stripped, a blank text becomes null and an entry with no text
     * left is dropped. Lengths are checked after stripping.
     *
     * @param maxName        longest allowed name (title for a series)
     * @param maxDescription longest allowed description
     */
    public Map<String, LocalizedText> normalize(
            Map<String, LocalizedText> translations, int maxName, int maxDescription) {
        Map<String, LocalizedText> result = new LinkedHashMap<>();
        if (translations == null) {
            return result;
        }
        for (Map.Entry<String, LocalizedText> entry : translations.entrySet()) {
            String language = languages.require(entry.getKey());
            LocalizedText text = entry.getValue();
            if (text == null) {
                continue;
            }
            String name = nameOrNull(text.name());
            String description = descriptionOrNull(text.description());
            if (name != null && name.length() > maxName) {
                throw tooLong("name", maxName);
            }
            if (description != null && description.length() > maxDescription) {
                throw tooLong("description", maxDescription);
            }
            if (name != null || description != null) {
                result.put(language, new LocalizedText(name, description));
            }
        }
        return result;
    }

    /** A name is one line without invisible or text-direction characters; nothing visible left means not translated. */
    private static String nameOrNull(String value) {
        if (value == null) {
            return null;
        }
        String stripped = value.strip();
        if (!ONE_LINE.matcher(stripped).matches()) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.BAD_REQUEST,
                    "translated name must be a single line of text without control characters");
        }
        String cleaned = UserText.cleanName(stripped);
        return cleaned.isEmpty() ? null : cleaned;
    }

    private static String descriptionOrNull(String value) {
        if (value == null) {
            return null;
        }
        String cleaned = UserText.clean(value);
        return cleaned.isEmpty() ? null : cleaned;
    }

    private static ApiException tooLong(String field, int max) {
        return new ApiException(
                ErrorCode.VALIDATION_ERROR,
                HttpStatus.BAD_REQUEST,
                "translated " + field + " must be at most " + max + " characters");
    }
}
