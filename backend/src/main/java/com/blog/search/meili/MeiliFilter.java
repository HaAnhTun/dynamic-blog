package com.blog.search.meili;

import java.util.Collection;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Builds Meilisearch filter expressions. Never accepts a filter string from the user: only an attribute from
 * {@link MeiliSettings#FILTERABLE} and a value that is a checked slug ({@code ^[a-z0-9-]+$}), or a language code for {@link #languageOrMissing}; any other value throws,
 * before any call. The value is always in double quotes, with {@code \} then {@code "} escaped: for a valid slug the
 * escaping changes nothing, it is the second line of defense. Several tags (AND) go as several elements of the array
 * form, not as a string joined with AND.
 */
public final class MeiliFilter {

    private static final Pattern SLUG = Pattern.compile("[a-z0-9-]{1,255}");

    private static final Pattern LANGUAGE = Pattern.compile("[a-z]{2,8}");

    private MeiliFilter() {}

    /** {@code attribute = "slug"}. */
    public static String equalTo(String attribute, String slug) {
        return attribute(attribute) + " = " + quote(slug(slug));
    }

    /** {@code attribute IN ["a", "b"]}. */
    public static String in(String attribute, Collection<String> slugs) {
        if (slugs.isEmpty()) {
            throw new IllegalArgumentException("IN needs at least one value");
        }
        return attribute(attribute) + " IN ["
                + slugs.stream().map(MeiliFilter::slug).map(MeiliFilter::quote).collect(Collectors.joining(", ")) + "]";
    }

    /**
     * {@code (language = "xx" OR language NOT EXISTS)}: a document of that language, or one with no language at all
     * (static pages and case studies). The value must be a language code.
     */
    public static String languageOrMissing(String language) {
        if (language == null || !LANGUAGE.matcher(language).matches()) {
            throw new IllegalArgumentException("Filter value is not a language");
        }
        String attribute = attribute("language");
        return "(" + attribute + " = " + quote(language) + " OR " + attribute + " NOT EXISTS)";
    }

    /** A value in double quotes, escaping {@code \} first and then {@code "}, as the Meilisearch filter parser expects. */
    static String quote(String value) {
        return '"' + value.replace("\\", "\\\\").replace("\"", "\\\"") + '"';
    }

    private static String attribute(String attribute) {
        if (!MeiliSettings.FILTERABLE.contains(attribute)) {
            throw new IllegalArgumentException("Attribute is not filterable");
        }
        return attribute;
    }

    /** The error message does not echo the value: it may be something the user typed. */
    private static String slug(String value) {
        if (value == null || !SLUG.matcher(value).matches()) {
            throw new IllegalArgumentException("Filter value is not a slug");
        }
        return value;
    }
}
