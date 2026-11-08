package com.blog.common.i18n;

import java.util.Map;

/**
 * One locale of a taxonomy row ({@code translations} JSON of categories, tags, series). A series keeps its title in {@code name}.
 * Blank means "not translated": the base text is used.
 */
public record LocalizedText(String name, String description) {

    /** The localized name when there is a non-blank one, otherwise the base. */
    public static String name(Map<String, LocalizedText> translations, String language, String base) {
        LocalizedText text = language == null || translations == null ? null : translations.get(language);
        return text == null || text.name() == null || text.name().isBlank() ? base : text.name();
    }

    public static String description(Map<String, LocalizedText> translations, String language, String base) {
        LocalizedText text = language == null || translations == null ? null : translations.get(language);
        return text == null || text.description() == null || text.description().isBlank() ? base : text.description();
    }
}
