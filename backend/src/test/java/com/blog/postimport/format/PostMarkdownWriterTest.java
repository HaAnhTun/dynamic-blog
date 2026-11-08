package com.blog.postimport.format;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/** The writer emits the dialect of "Download .md", and what it writes the parser reads back. No Spring. */
class PostMarkdownWriterTest {

    private static final String EM_DASH = String.valueOf((char) 0x2014);

    private static PostFileValues post(
            String title, String excerpt, String category, List<String> tags, String content) {
        return new PostFileValues(
                title, "a-post", "en", excerpt, category, tags, Boolean.FALSE, "DRAFT", null, content);
    }

    /** The file as the import receives it: bytes, strict decode, parse. */
    private static ParsedPost readBack(String written) {
        return PostMarkdownParser.parse(1, "a-post.md", PostFile.decode(written.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void a_post_is_written_in_the_dialect_of_the_download_with_the_new_keys_last() {
        PostFileValues values = new PostFileValues(
                "From API Gateway to SQS",
                "my-post",
                "en",
                "Why I chose async.",
                "Architecture",
                List.of("AWS", "Architecture"),
                Boolean.TRUE,
                "PUBLISHED",
                "other-post",
                "## Intro\n\nParagraph one.\n");

        assertThat(PostMarkdownWriter.write(values)).isEqualTo("""
                ---
                # Exported from the admin. "status" is informational only: seed/push.py publishes every file it pushes.
                title: From API Gateway to SQS
                excerpt: Why I chose async.
                category: Architecture
                tags: AWS, Architecture
                featured: true
                status: PUBLISHED
                slug: my-post
                language: en
                translation_of: other-post
                ---

                ## Intro

                Paragraph one.
                """);
    }

    @Test
    void empty_values_are_written_without_a_trailing_space_and_the_optional_keys_are_left_out() {
        PostFileValues values = new PostFileValues(
                "Only a title", "only-a-title", null, null, null, List.of(), null, null, null, "Body");

        assertThat(PostMarkdownWriter.write(values)).isEqualTo("""
                ---
                # Exported from the admin. "status" is informational only: seed/push.py publishes every file it pushes.
                title: Only a title
                excerpt:
                category:
                tags:
                featured: false
                status:
                slug: only-a-title
                ---

                Body
                """);
    }

    @Test
    void values_are_written_on_one_line() {
        PostFileValues values = post(
                "Line one\nline two", "Sentence one.\n\nSentence two.\r\nSentence three.", "A --- B", List.of(), "x");

        String written = PostMarkdownWriter.write(values);

        assertThat(written)
                .contains("title: Line one line two\n")
                .contains("excerpt: Sentence one. Sentence two. Sentence three.\n")
                .contains("category: A " + EM_DASH + " B\n");
    }

    @Test
    void a_comma_in_a_tag_name_becomes_a_space_and_empty_tags_are_dropped() {
        PostFileValues values = post("T", null, null, List.of("Node.js, Deno", "AWS", " ", ","), "x");

        assertThat(PostMarkdownWriter.write(values)).contains("tags: Node.js Deno, AWS\n");
    }

    @Test
    void the_body_keeps_its_text_and_gets_one_final_newline_only_when_it_has_none() {
        assertThat(PostMarkdownWriter.write(post("T", null, null, List.of(), "No newline")))
                .endsWith("---\n\nNo newline\n");
        assertThat(PostMarkdownWriter.write(post("T", null, null, List.of(), "One\n")))
                .endsWith("---\n\nOne\n");
        assertThat(PostMarkdownWriter.write(post("T", null, null, List.of(), "Two\n\n")))
                .endsWith("---\n\nTwo\n\n");
        assertThat(PostMarkdownWriter.write(post("T", null, null, List.of(), "")))
                .endsWith("---\n\n\n");
    }

    @Test
    void a_body_with_a_horizontal_rule_and_a_front_matter_look_alike_stays_intact() {
        String content = "Above\n\n---\n\ntitle: not a key\n\n```yaml\n---\nkey: v\n```\n";

        ParsedPost parsed = readBack(PostMarkdownWriter.write(post("T", null, null, List.of(), content)));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().content()).isEqualTo(content);
    }

    // ---- writer, then parser, returns the same values ----------------------------------------------------------

    static Stream<Arguments> posts() {
        String nfd = Normalizer.normalize("Cafe" + (char) 0x00E9, Normalizer.Form.NFD);
        return Stream.of(
                Arguments.of("a plain post", post("A plain post", "Short.", "Guides", List.of("one", "two"), "Text\n")),
                Arguments.of("no trailing newline", post("No newline", "E", "Guides", List.of("a"), "Last line")),
                Arguments.of(
                        "three hyphens in a title and a description",
                        post("Before --- after", "a ---- b", "Guides", List.of("x"), "Text\n")),
                Arguments.of(
                        "a comma in a tag name",
                        post("Tags", "E", "Guides", List.of("Node.js, Deno", "AWS"), "Text\n")),
                Arguments.of(
                        "a multi-line description",
                        post(
                                "Description",
                                "Sentence one.\n\nSentence two.\r\nSentence three.",
                                "Guides",
                                List.of(),
                                "x")),
                Arguments.of(
                        "CRLF and NFD content",
                        post(nfd, "E " + nfd, "Guides", List.of(nfd), "Line one\r\n\r\n" + nfd + "\r\nLast\r\n")),
                Arguments.of("no category", post("No category", "E", null, List.of("a"), "Text\n")),
                Arguments.of(
                        "a category name with accents",
                        post("Accents", "E", "Cr" + (char) 0x00E8 + "me", List.of("caf" + (char) 0x00E9), "Text\n")),
                Arguments.of(
                        "leading blank lines in the body",
                        post("Leading", "E", "Guides", List.of(), "\n\n  \nBody after blanks\n")),
                Arguments.of(
                        "a title with a colon and quotes",
                        post("Java: \"what\" I [learned]", "E", "Guides", List.of(), "x\n")),
                Arguments.of(
                        "a translation link",
                        new PostFileValues(
                                "Linked",
                                "linked",
                                "vi",
                                "E",
                                "Guides",
                                List.of("a"),
                                null,
                                "DRAFT",
                                "lien-ket",
                                "x\n")));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("posts")
    void writing_then_parsing_returns_the_same_values(String name, PostFileValues in) {
        ParsedPost parsed = readBack(PostMarkdownWriter.write(in));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored()).isEmpty();
        PostFileValues out = parsed.values();
        assertThat(out.title()).isEqualTo(emptyToNull(PostNormalForm.line(in.title())));
        assertThat(out.excerpt()).isEqualTo(emptyToNull(PostNormalForm.line(in.excerpt())));
        assertThat(out.category()).isEqualTo(emptyToNull(PostNormalForm.line(in.category())));
        assertThat(out.tags())
                .containsExactlyElementsOf(in.tags().stream()
                        .map(PostNormalForm::tag)
                        .filter(tag -> !tag.isEmpty())
                        .toList());
        assertThat(out.slug()).isEqualTo(in.slug());
        assertThat(parsed.slugSource()).isEqualTo(SlugSource.KEY);
        assertThat(out.language()).isEqualTo(in.language());
        assertThat(out.translationOf()).isEqualTo(in.translationOf());
        assertThat(out.status()).isEqualTo(in.status());
        assertThat(out.featured()).isEqualTo(Boolean.TRUE.equals(in.featured()));
        assertThat(PostNormalForm.content(out.content())).isEqualTo(PostNormalForm.content(in.content()));
    }

    @ParameterizedTest(name = "{0}")
    @MethodSource("posts")
    void a_value_read_back_is_already_in_normal_form(String name, PostFileValues in) {
        PostFileValues out = readBack(PostMarkdownWriter.write(in)).values();

        assertThat(PostNormalForm.line(out.title())).isEqualTo(nullToEmpty(out.title()));
        assertThat(PostNormalForm.line(out.excerpt())).isEqualTo(nullToEmpty(out.excerpt()));
        assertThat(PostNormalForm.line(out.category())).isEqualTo(nullToEmpty(out.category()));
        out.tags().forEach(tag -> assertThat(PostNormalForm.tag(tag)).isEqualTo(tag));
    }

    private static String emptyToNull(String value) {
        return value.isEmpty() ? null : value;
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }
}
