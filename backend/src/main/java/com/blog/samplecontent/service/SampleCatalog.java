package com.blog.samplecontent.service;

import com.blog.common.i18n.LocalizedText;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.core.io.ClassPathResource;

/**
 * The packaged sample content, read from {@code sample-content/<language>/<file>.md}. A file is a small {@code key: value}
 * header, an empty line, then the Markdown body. The files with the same {@code group} header, one per language, are
 * translations of each other.
 *
 * Category, tag and series names are written in each file in the language of that file. The English text is the key of the
 * item; the same position (the same tag index) in the other language is its translation. Immutable once built.
 */
public final class SampleCatalog {

    static final String ROOT = "sample-content/";
    /** The language whose names are the keys of the items. */
    static final String KEY_LANGUAGE = "en";

    static final List<String> LANGUAGES = List.of("en", "vi");
    /** Group and file name of every sample article, in the order they are listed. */
    static final Map<String, String> FILES = Map.of("welcome", "welcome.md", "markdown", "writing-in-markdown.md");

    private static final List<String> GROUPS = List.of("welcome", "markdown");

    private static final Set<String> HEADER_KEYS =
            Set.of("title", "excerpt", "slug", "category", "tags", "series", "series_description", "group");

    /** One sample post. Category, tags and series are the keys of the items (their English names). */
    public record SamplePost(
            String language,
            String group,
            String title,
            String excerpt,
            String slug,
            String content,
            String categoryKey,
            List<String> tagKeys,
            String seriesKey) {}

    /** One category, tag or series: the key and its name (and description) in every language of the sample files. */
    public record SampleItem(String key, Map<String, LocalizedText> translations) {}

    private final List<SamplePost> posts;
    private final List<SampleItem> categories;
    private final List<SampleItem> tags;
    private final List<SampleItem> series;

    private SampleCatalog(
            List<SamplePost> posts, List<SampleItem> categories, List<SampleItem> tags, List<SampleItem> series) {
        this.posts = List.copyOf(posts);
        this.categories = List.copyOf(categories);
        this.tags = List.copyOf(tags);
        this.series = List.copyOf(series);
    }

    /** Posts by language (in the order of {@link #LANGUAGES}), then by group. */
    public List<SamplePost> posts() {
        return posts;
    }

    public List<SampleItem> categories() {
        return categories;
    }

    public List<SampleItem> tags() {
        return tags;
    }

    public List<SampleItem> series() {
        return series;
    }

    public static SampleCatalog load() {
        Map<String, String> files = new LinkedHashMap<>();
        for (String language : LANGUAGES) {
            for (String group : GROUPS) {
                files.put(language + "/" + group, read(ROOT + language + "/" + FILES.get(group)));
            }
        }
        return parse(files);
    }

    private static String read(String path) {
        try (InputStream in = new ClassPathResource(path).getInputStream()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("Sample content file is missing: " + path, e);
        }
    }

    /**
     * Builds the catalog from the text of each file.
     *
     * @param files file text by {@code "<language>/<group>"}; every language needs every group
     * @throws IllegalStateException when a header is malformed or unknown, a required header is missing, the group does
     *                               not match the file, or the languages of a group do not line up
     */
    static SampleCatalog parse(Map<String, String> files) {
        List<Raw> raws = new ArrayList<>();
        Map<String, String> seriesDescriptions = new LinkedHashMap<>();
        for (String language : LANGUAGES) {
            for (String group : GROUPS) {
                String name = language + "/" + group;
                String text = files.get(name);
                if (text == null) {
                    throw new IllegalStateException("Missing sample file " + name);
                }
                Raw raw = parseFile(text, name, language);
                if (!group.equals(raw.header.get("group"))) {
                    throw new IllegalStateException(name + ": the group header does not match");
                }
                String description = raw.header.get("series_description");
                if (description != null) {
                    seriesDescriptions.put(language, description);
                }
                raws.add(raw);
            }
        }
        return build(raws, seriesDescriptions);
    }

    private static SampleCatalog build(List<Raw> raws, Map<String, String> seriesDescriptions) {
        Map<String, Map<String, LocalizedText>> categories = new LinkedHashMap<>();
        Map<String, Map<String, LocalizedText>> tags = new LinkedHashMap<>();
        Map<String, Map<String, LocalizedText>> series = new LinkedHashMap<>();
        List<SamplePost> posts = new ArrayList<>();
        for (Raw raw : raws) {
            Raw key = raws.stream()
                    .filter(r -> r.group.equals(raw.group) && r.language.equals(KEY_LANGUAGE))
                    .findFirst()
                    .orElseThrow(() -> new IllegalStateException("Group " + raw.group + " has no English file"));
            if (raw.tags.size() != key.tags.size()) {
                throw new IllegalStateException("Group " + raw.group + ": every language needs the same tags");
            }
            put(categories, key.category, raw.language, new LocalizedText(raw.category, null));
            put(series, key.series, raw.language, new LocalizedText(raw.series, seriesDescriptions.get(raw.language)));
            for (int i = 0; i < raw.tags.size(); i++) {
                put(tags, key.tags.get(i), raw.language, new LocalizedText(raw.tags.get(i), null));
            }
            posts.add(new SamplePost(
                    raw.language,
                    raw.group,
                    raw.title,
                    raw.excerpt,
                    raw.slug,
                    raw.body,
                    key.category,
                    key.tags,
                    key.series));
        }
        return new SampleCatalog(posts, items(categories), items(tags), items(series));
    }

    private static void put(
            Map<String, Map<String, LocalizedText>> items, String key, String language, LocalizedText text) {
        items.computeIfAbsent(key, k -> new LinkedHashMap<>()).put(language, text);
    }

    private static List<SampleItem> items(Map<String, Map<String, LocalizedText>> byKey) {
        return byKey.entrySet().stream()
                .map(e -> new SampleItem(e.getKey(), Map.copyOf(e.getValue())))
                .toList();
    }

    /** A file as written: the header values and the body. */
    private record Raw(
            String language,
            String group,
            Map<String, String> header,
            String title,
            String excerpt,
            String slug,
            String category,
            List<String> tags,
            String series,
            String body) {}

    private static Raw parseFile(String text, String name, String language) {
        String normalized = text.replace("\r\n", "\n");
        int split = normalized.indexOf("\n\n");
        if (split < 0) {
            throw new IllegalStateException(name + ": no empty line between the header and the body");
        }
        Map<String, String> header = new LinkedHashMap<>();
        for (String line : normalized.substring(0, split).split("\n")) {
            int colon = line.indexOf(':');
            if (colon <= 0) {
                throw new IllegalStateException(name + ": a header line is not key: value");
            }
            String key = line.substring(0, colon).strip();
            if (!HEADER_KEYS.contains(key)) {
                throw new IllegalStateException(name + ": unknown header key " + key);
            }
            if (header.put(key, line.substring(colon + 1).strip()) != null) {
                throw new IllegalStateException(name + ": header key repeated " + key);
            }
        }
        String body = normalized.substring(split + 2).strip();
        if (body.isEmpty()) {
            throw new IllegalStateException(name + ": the body is empty");
        }
        return new Raw(
                language,
                header.get("group"),
                header,
                require(header, "title", name),
                require(header, "excerpt", name),
                require(header, "slug", name),
                require(header, "category", name),
                splitTags(header.get("tags")),
                require(header, "series", name),
                body);
    }

    private static String require(Map<String, String> header, String key, String name) {
        String value = header.get(key);
        if (value == null || value.isBlank()) {
            throw new IllegalStateException(name + ": missing header " + key);
        }
        return value;
    }

    private static List<String> splitTags(String value) {
        if (value == null || value.isBlank()) {
            return List.of();
        }
        return Arrays.stream(value.split(","))
                .map(String::strip)
                .filter(s -> !s.isEmpty())
                .toList();
    }
}
