package com.blog.postimport.format;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.i18n.LocalizedText;
import com.blog.samplecontent.service.SampleCatalog;
import com.blog.samplecontent.service.SampleCatalog.SampleItem;
import com.blog.samplecontent.service.SampleCatalog.SamplePost;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** The downloadable template: instructions, annotated keys and a neutral example from the packaged sample posts. */
class PostTemplateGeneratorTest {

    private final PostTemplateGenerator generator = new PostTemplateGenerator();
    private final SampleCatalog catalog = SampleCatalog.load();

    private static ParsedPost read(String template) {
        return PostMarkdownParser.parse(1, "template.md", PostFile.decode(template.getBytes(StandardCharsets.UTF_8)));
    }

    private SamplePost firstSample(String language) {
        return catalog.posts().stream()
                .filter(post -> post.language().equals(language))
                .findFirst()
                .orElseThrow();
    }

    private String name(List<SampleItem> items, String key, String language) {
        SampleItem item =
                items.stream().filter(i -> i.key().equals(key)).findFirst().orElseThrow();
        return LocalizedText.name(item.translations(), language, key);
    }

    @ParameterizedTest
    @ValueSource(strings = {"en", "vi", "fr", "xx"})
    void the_template_parses_without_any_problem_or_ignored_key(String language) {
        ParsedPost parsed = read(generator.template(language));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored()).isEmpty();
        assertThat(parsed.ignoredTotal()).isZero();
        assertThat(parsed.values().language()).isEqualTo(language);
        assertThat(parsed.values().title()).isNotBlank();
        assertThat(parsed.values().content()).isNotBlank();
    }

    @ParameterizedTest
    @ValueSource(strings = {"en", "vi"})
    void the_example_is_the_packaged_sample_post_of_the_language(String language) {
        SamplePost sample = firstSample(language);

        ParsedPost parsed = read(generator.template(language));

        PostFileValues values = parsed.values();
        assertThat(values.title()).isEqualTo(sample.title());
        assertThat(values.excerpt()).isEqualTo(sample.excerpt());
        assertThat(values.slug()).isEqualTo(PostTemplateGenerator.EXAMPLE_SLUG).isNotEqualTo(sample.slug());
        assertThat(parsed.slugSource()).isEqualTo(SlugSource.KEY);
        assertThat(values.category()).isEqualTo(name(catalog.categories(), sample.categoryKey(), language));
        assertThat(values.tags())
                .containsExactlyElementsOf(sample.tagKeys().stream()
                        .map(key -> name(catalog.tags(), key, language))
                        .toList());
        assertThat(PostNormalForm.content(values.content())).isEqualTo(PostNormalForm.content(sample.content()));
        assertThat(values.featured()).isNull();
        assertThat(values.status()).isNull();
        assertThat(values.translationOf()).isNull();
    }

    @Test
    void a_language_without_a_packaged_example_falls_back_to_the_english_one_and_keeps_its_own_language_key() {
        SamplePost english = firstSample("en");

        ParsedPost parsed = read(generator.template("fr"));

        assertThat(parsed.values().title()).isEqualTo(english.title());
        assertThat(parsed.values().slug()).isEqualTo(PostTemplateGenerator.EXAMPLE_SLUG);
        assertThat(parsed.values().category()).isEqualTo(name(catalog.categories(), english.categoryKey(), "en"));
        assertThat(parsed.values().language()).isEqualTo("fr");
        assertThat(generator.template("fr")).contains("(language: French, code: fr)");
    }

    @ParameterizedTest
    @ValueSource(strings = {"en", "vi", "fr"})
    void the_template_carries_the_instructions_for_an_assistant(String language) {
        String template = generator.template(language);

        assertThat(template)
                .startsWith("---\n# INSTRUCTIONS FOR AN AI ASSISTANT\n")
                .contains("Use only facts that are in the material")
                .contains("leave the value empty")
                .contains("never invent it")
                .contains("Never invent facts, numbers, dates, names, quotations or links")
                .contains("Keep the keys exactly as written below")
                .contains("do not add keys")
                .contains("Keep one stable slug line")
                .contains("never change the slug of a post")
                .contains("One value per line")
                .contains("Return only the finished file")
                .contains("Write the title, excerpt, category, tags and the post text in ")
                .contains("Keep language: " + language)
                .contains("a line that starts with # is a comment")
                .contains("leave out featured and status");
    }

    @Test
    void the_language_of_the_post_is_named_in_the_instructions() {
        assertThat(generator.template("en")).contains("(language: English, code: en)");
        assertThat(generator.template("vi")).contains("(language: Vietnamese, code: vi)");
        assertThat(generator.template("vi")).contains("post text in Vietnamese");
    }

    @Test
    void every_key_of_the_format_is_annotated_with_its_limits() {
        String template = generator.template("en");

        assertThat(template)
                .contains("# title (required for a new post): ")
                .contains("at most " + PostFileLimits.MAX_TITLE_CHARS + " characters")
                .contains("# slug (optional): ")
                .contains("# language (optional): ")
                .contains("# excerpt (optional): ")
                .contains("# category (optional): ")
                .contains("# tags (optional): ")
                .contains("at most " + PostFileLimits.MAX_TAGS + " tags")
                .contains("at most " + PostFileLimits.MAX_TAG_CHARS + " characters");
        assertThat(PostKey.values())
                .filteredOn(key -> key != PostKey.FEATURED
                        && key != PostKey.STATUS
                        && key != PostKey.TRANSLATION_OF
                        && key != PostKey.COVER
                        && key != PostKey.COVER_ALT)
                .allSatisfy(key -> assertThat(template).contains("\n" + key.keyName() + ":"));
    }

    @Test
    void translation_of_is_not_offered_while_the_import_does_not_link_translations() {
        assertThat(generator.template("en")).doesNotContain("translation_of");
        assertThat(generator.template("vi")).doesNotContain("translation_of");
    }

    @Test
    void featured_and_status_are_left_out_of_the_example() {
        String template = generator.template("en");

        assertThat(template).doesNotContain("\nfeatured:").doesNotContain("\nstatus:");
    }

    @ParameterizedTest
    @ValueSource(strings = {"en", "vi", "fr"})
    void the_front_matter_fits_the_line_cap_of_the_format(String language) {
        String template = generator.template(language);
        int close = template.indexOf("\n---\n", 4);

        long lines = template.substring(4, close).lines().count();

        assertThat(lines).isLessThanOrEqualTo(PostFileLimits.MAX_FRONT_MATTER_LINES);
        assertThat(template.substring(4, close).lines())
                .allSatisfy(line ->
                        assertThat(line.length()).isLessThanOrEqualTo(PostFileLimits.MAX_FRONT_MATTER_LINE_CHARS));
    }

    @ParameterizedTest
    @ValueSource(strings = {"en", "vi", "fr"})
    void the_instructions_are_english_text_and_the_template_ends_with_a_newline(String language) {
        String template = generator.template(language);

        String frontMatter = template.substring(0, template.indexOf("\n---\n", 4));

        assertThat(template).endsWith("\n");
        assertThat(frontMatter.lines().filter(line -> line.startsWith("#")))
                .isNotEmpty()
                .allSatisfy(line ->
                        assertThat(line.chars().allMatch(c -> c < 128)).as(line).isTrue());
    }

    @Test
    void the_english_template_has_only_ascii_text() {
        assertThat(generator.template("en").chars().allMatch(c -> c < 128)).isTrue();
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "EN", "e", "english-language", "en/../x", "en\n", "vi_VN"})
    void a_language_that_is_not_a_lower_case_code_is_refused(String language) {
        assertThatThrownBy(() -> generator.template(language)).isInstanceOf(IllegalArgumentException.class);
    }
}
