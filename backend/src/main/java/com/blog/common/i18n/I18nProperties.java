package com.blog.common.i18n;

import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * The content languages, bound from {@code app.i18n.*}.
 *
 * The shape of every code is checked here, before anything uses it: the default locale becomes the Flyway placeholder
 * {@code defaultLocale} that V34 writes into DDL as SQL text (see {@code I18nConfig}), and the list is what
 * {@code Languages} accepts from every request. So a code is two to eight lower-case letters, an entry is never empty, and a
 * language is listed once. A bad value stops the start with a message that names the setting, so it never reaches the
 * migration. Which codes the database accepts is a separate fact: V35 pins {@code vi} and {@code en}, and another language
 * needs a migration (docs/CONTENT-AND-I18N.md).
 *
 * @param locales       the enabled locales, lower-case language codes; the database pins the same set (V35)
 * @param defaultLocale one of {@code locales}: the fallback of a missing translation and the language of anything created
 *                      without one
 */
@ConfigurationProperties("app.i18n")
public record I18nProperties(List<String> locales, String defaultLocale) {

    private static final Pattern LANGUAGE_CODE = Pattern.compile("[a-z]{2,8}");

    public I18nProperties {
        List<String> cleaned = locales == null || locales.isEmpty()
                ? List.of("vi", "en")
                : locales.stream()
                        .map(code -> code == null ? "" : code.strip().toLowerCase(Locale.ROOT))
                        .toList();
        for (String code : cleaned) {
            if (!LANGUAGE_CODE.matcher(code).matches()) {
                throw new IllegalArgumentException(
                        "app.i18n.locales has an entry that is not a language code: each "
                                + "one is 2 to 8 lower-case letters (such as vi or en), separated by commas, with no empty entry");
            }
        }
        if (new HashSet<>(cleaned).size() != cleaned.size()) {
            throw new IllegalArgumentException("app.i18n.locales lists a language twice: " + cleaned);
        }
        locales = cleaned;
        defaultLocale = defaultLocale == null || defaultLocale.isBlank()
                ? locales.get(0)
                : defaultLocale.strip().toLowerCase(Locale.ROOT);
        if (!locales.contains(defaultLocale)) {
            throw new IllegalArgumentException("app.i18n.default-locale must be one of app.i18n.locales: " + locales);
        }
    }
}
