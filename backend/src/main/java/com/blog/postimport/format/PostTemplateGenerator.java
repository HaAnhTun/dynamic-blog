package com.blog.postimport.format;

import com.blog.common.i18n.LocalizedText;
import com.blog.samplecontent.service.SampleCatalog;
import com.blog.samplecontent.service.SampleCatalog.SampleItem;
import com.blog.samplecontent.service.SampleCatalog.SamplePost;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * The downloadable template of a language: instructions for an AI assistant, every key annotated, and a neutral example post
 * taken from the packaged sample posts ({@code sample-content/<language>/}). A language without a packaged example gets the
 * English one, with its own {@code language} key. The instructions and the notes are comment lines of the front matter, so
 * they are never imported as post text, and the template parses without any problem or ignored key.
 */
@Component
public class PostTemplateGenerator {

    /**
     * A neutral address that is not the slug of a packaged sample post: with update by slug, a template that kept the
     * sample slug would aim at the sample post that "Load sample content" creates.
     */
    static final String EXAMPLE_SLUG = "my-first-post";

    private static final String FALLBACK_LANGUAGE = "en";
    private static final Pattern LANGUAGE_CODE = Pattern.compile("[a-z]{2,8}");

    /** The language is a code such as {@code vi}; the caller has checked that the site enables it. */
    public String template(String language) {
        if (!LANGUAGE_CODE.matcher(language).matches()) {
            throw new IllegalArgumentException("language must be a lower-case language code");
        }
        SampleCatalog catalog = SampleCatalog.load();
        SamplePost example = example(catalog, language);

        List<String> meta = new ArrayList<>(instructions(language));
        meta.add("");
        addKey(meta, PostKey.TITLE, example.title(), language);
        addKey(meta, PostKey.SLUG, EXAMPLE_SLUG, language);
        addKey(meta, PostKey.LANGUAGE, language, language);
        addKey(meta, PostKey.EXCERPT, example.excerpt(), language);
        addKey(meta, PostKey.CATEGORY, name(catalog.categories(), example.categoryKey(), example.language()), language);
        addKey(meta, PostKey.TAGS, tags(catalog, example), language);
        // Left empty: a template post is not in a series, and an empty series key does nothing.
        addKey(meta, PostKey.SERIES, "", language);
        addKey(meta, PostKey.SERIES_PART, "", language);
        addKey(meta, PostKey.SERIES_DESCRIPTION, "", language);
        // translation_of is left out until the import links translations: the template must not ask for a key that is
        // ignored.
        return PostMarkdownWriter.frontMatter(meta) + "\n" + PostMarkdownWriter.body(example.content());
    }

    private static void addKey(List<String> meta, PostKey key, String value, String language) {
        meta.addAll(notes(key, language));
        meta.add(PostMarkdownWriter.keyLine(key, PostNormalForm.line(value)));
    }

    private static SamplePost example(SampleCatalog catalog, String language) {
        return catalog.posts().stream()
                .filter(post -> post.language().equals(language))
                .findFirst()
                .or(() -> catalog.posts().stream()
                        .filter(post -> post.language().equals(FALLBACK_LANGUAGE))
                        .findFirst())
                .orElseThrow(() -> new IllegalStateException("The sample content has no English post"));
    }

    private static String name(List<SampleItem> items, String key, String language) {
        return items.stream()
                .filter(item -> item.key().equals(key))
                .findFirst()
                .map(item -> LocalizedText.name(item.translations(), language, key))
                .orElse(key);
    }

    private static String tags(SampleCatalog catalog, SamplePost example) {
        return String.join(
                ", ",
                example.tagKeys().stream()
                        .map(key -> PostNormalForm.tag(name(catalog.tags(), key, example.language())))
                        .toList());
    }

    private static List<String> instructions(String language) {
        String name = Locale.forLanguageTag(language).getDisplayLanguage(Locale.ENGLISH);
        String displayName = name.isEmpty() ? language : name;
        return List.of(
                "# INSTRUCTIONS FOR AN AI ASSISTANT",
                "# Write ONE blog post as a file in exactly this format (language: " + displayName + ", code: "
                        + language + "), from the material the author gives you.",
                "# Follow these rules exactly.",
                "#",
                "# 1. Use only facts that are in the material. When a fact is unknown, leave the value empty;",
                "#    never invent it.",
                "# 2. Never invent facts, numbers, dates, names, quotations or links. Every figure you write must come",
                "#    from the material.",
                "# 3. Keep the keys exactly as written below, in this order. Do not rename keys and do not add keys.",
                "# 4. Keep one stable slug line. The slug is the web address of the post: never change the slug of a post",
                "#    that exists.",
                "# 5. One value per line. Never wrap a value over several lines. Respect the limits written next to each",
                "#    key.",
                "# 6. No HTML and no scripts anywhere in the file.",
                "# 7. Write the title, excerpt, category, tags and the post text in " + displayName
                        + ". Keep language: " + language + ".",
                "# 8. Return only the finished file, starting with the first --- line, nothing before or after it.",
                "#",
                "# The front matter is the block between the two --- lines; a line that starts with # is a comment and is",
                "# ignored. The post itself is Markdown and starts after the second --- line. The import never publishes a",
                "# post, so leave out featured and status.");
    }

    /** What the key means and its limits, as comment lines placed right above the key. */
    private static List<String> notes(PostKey key, String language) {
        return switch (key) {
            case TITLE ->
                List.of("# title (required for a new post): the title of the post, at most "
                        + PostFileLimits.MAX_TITLE_CHARS + " characters.");
            case SLUG ->
                List.of(
                        "# slug (optional): the web address of the post, in lower case letters, digits and hyphens.",
                        "#   When it is empty the file name is used, then the title. Keep it stable.");
            case LANGUAGE ->
                List.of(
                        "# language (optional): the language code of the post, here " + language
                                + ". When it is empty a new",
                        "#   post takes the default language of the site and an existing post keeps its language.");
            case EXCERPT ->
                List.of("# excerpt (optional): one or two sentences that sum up the post, at most "
                        + PostFileLimits.MAX_EXCERPT_CHARS + " characters.");
            case CATEGORY ->
                List.of(
                        "# category (optional): the name of one category, at most " + PostFileLimits.MAX_CATEGORY_CHARS
                                + " characters.",
                        "#   A name that does not exist yet creates a new category.");
            case TAGS ->
                List.of(
                        "# tags (optional): tag names separated by commas, at most " + PostFileLimits.MAX_TAGS
                                + " tags of at most " + PostFileLimits.MAX_TAG_CHARS + " characters.",
                        "#   A name that does not exist yet creates a new tag.");
            case TRANSLATION_OF ->
                List.of(
                        "# translation_of (optional): the slug of the post in another language that this post translates.",
                        "#   Leave it empty when there is none.");
            case SERIES ->
                List.of(
                        "# series (optional, administrators only): the name of the series this post belongs to, at most "
                                + PostFileLimits.MAX_SERIES_CHARS + " characters.",
                        "#   A name that does not exist yet creates the series. Use the same name in every part, and write",
                        "#   series_part with it.");
            case SERIES_PART ->
                List.of("# series_part (needed with series): the number of this post in the series, from 1 to "
                        + PostFileLimits.MAX_SERIES_PART + ", unique in the series.");
            case SERIES_DESCRIPTION ->
                List.of(
                        "# series_description (optional): the description of the series, at most "
                                + PostFileLimits.MAX_SERIES_DESCRIPTION_CHARS
                                + " characters. It is used when the import",
                        "#   creates the series or finds it without a description, and never replaces a description.",
                        "#   Write the same line in every part.");
            // The cover keys are not in the template until the import applies them.
            case FEATURED, STATUS, COVER, COVER_ALT -> List.of();
        };
    }
}
