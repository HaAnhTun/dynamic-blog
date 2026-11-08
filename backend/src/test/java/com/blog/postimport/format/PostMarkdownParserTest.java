package com.blog.postimport.format;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.postimport.format.ParsedPost.Ignored;
import com.blog.postimport.format.ParsedPost.Problem;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.Collections;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * What the parser makes of a post file: front matter, body, slug source, ignored keys, caps, line numbers and problems.
 * No Spring.
 */
class PostMarkdownParserTest {

    /** A file: the front matter lines (each ends with a line feed), then a blank line and the body. */
    static String file(String frontMatter, String body) {
        return "---\n" + frontMatter + "---\n\n" + body;
    }

    static ParsedPost parse(String text) {
        return PostMarkdownParser.parse(1, "post.md", text);
    }

    static ParsedPost parse(String fileName, String text) {
        return PostMarkdownParser.parse(1, fileName, text);
    }

    private static List<String> messages(ParsedPost parsed) {
        return parsed.problems().stream().map(Problem::message).toList();
    }

    // ---- what a file gives ------------------------------------------------------------------------------------

    @Test
    void a_file_with_only_a_title_and_a_body_is_valid() {
        ParsedPost parsed = parse(file("title: A quick note\n", "Some text.\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored()).isEmpty();
        assertThat(parsed.values().title()).isEqualTo("A quick note");
        assertThat(parsed.values().content()).isEqualTo("Some text.\n");
        assertThat(parsed.values().tags()).isEmpty();
        assertThat(parsed.values().category()).isNull();
        assertThat(parsed.values().excerpt()).isNull();
        assertThat(parsed.values().language()).isNull();
        assertThat(parsed.values().translationOf()).isNull();
        assertThat(parsed.values().featured()).isNull();
        assertThat(parsed.values().status()).isNull();
        assertThat(parsed.position()).isEqualTo(1);
    }

    @Test
    void every_key_is_read_with_its_line_number() {
        ParsedPost parsed = parse(file("""
                title: Hello world
                slug: hello-there
                language: en
                excerpt: One sentence.
                category: Guides
                tags: first, second ,, third
                featured: TRUE
                status: PUBLISHED
                translation_of: bonjour
                """, "## Body\n\nText\n"));

        assertThat(parsed.problems()).isEmpty();
        PostFileValues values = parsed.values();
        assertThat(values.title()).isEqualTo("Hello world");
        assertThat(values.slug()).isEqualTo("hello-there");
        assertThat(values.language()).isEqualTo("en");
        assertThat(values.excerpt()).isEqualTo("One sentence.");
        assertThat(values.category()).isEqualTo("Guides");
        assertThat(values.tags()).containsExactly("first", "second", "third");
        assertThat(values.featured()).isTrue();
        assertThat(values.status()).isEqualTo("PUBLISHED");
        assertThat(values.translationOf()).isEqualTo("bonjour");
        assertThat(values.content()).isEqualTo("## Body\n\nText\n");
        assertThat(parsed.slugSource()).isEqualTo(SlugSource.KEY);
        assertThat(parsed.lines())
                .containsEntry(PostKey.TITLE, 2)
                .containsEntry(PostKey.SLUG, 3)
                .containsEntry(PostKey.LANGUAGE, 4)
                .containsEntry(PostKey.EXCERPT, 5)
                .containsEntry(PostKey.CATEGORY, 6)
                .containsEntry(PostKey.TAGS, 7)
                .containsEntry(PostKey.FEATURED, 8)
                .containsEntry(PostKey.STATUS, 9)
                .containsEntry(PostKey.TRANSLATION_OF, 10);
        assertThat(parsed.bodyLine()).isEqualTo(13);
    }

    @Test
    void the_series_keys_are_read_with_their_line_numbers() {
        ParsedPost parsed = parse(file("""
                title: Part three
                series: Queues in practice
                series_part: 3
                series_description: A short series about queues.
                """, "Text\n"));

        assertThat(parsed.problems()).isEmpty();
        PostFileValues values = parsed.values();
        assertThat(values.series()).isEqualTo("Queues in practice");
        assertThat(values.seriesPart()).isEqualTo(3);
        assertThat(values.seriesDescription()).isEqualTo("A short series about queues.");
        assertThat(parsed.lines())
                .containsEntry(PostKey.SERIES, 3)
                .containsEntry(PostKey.SERIES_PART, 4)
                .containsEntry(PostKey.SERIES_DESCRIPTION, 5);
        assertThat(parsed.ignored()).isEmpty();
    }

    @Test
    void a_file_without_series_keys_has_no_series_values() {
        PostFileValues values = parse(file("title: A\n", "x\n")).values();

        assertThat(values.series()).isNull();
        assertThat(values.seriesPart()).isNull();
        assertThat(values.seriesDescription()).isNull();
    }

    @ParameterizedTest
    @CsvSource({"1,1", "10,10", "1000,1000", "007,7", "0001,1"})
    void series_part_is_a_whole_number_from_1_to_1000(String value, int expected) {
        ParsedPost parsed = parse(file("series: S\nseries_part: " + value + "\n", "x\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().seriesPart()).isEqualTo(expected);
    }

    @ParameterizedTest
    @ValueSource(
            strings = {
                "0",
                "1001",
                "00",
                "-1",
                "+2",
                "2.5",
                "1e3",
                "1,000",
                "two",
                "1 2",
                "99999999999999999999999",
                "\u0663",
                "\uff11"
            })
    void series_part_that_is_not_a_whole_number_from_1_to_1000_is_a_problem_without_the_value(String value) {
        ParsedPost parsed = parse(file("series: S\nseries_part: " + value + "\n", "x\n"));

        assertThat(parsed.problems())
                .containsExactly(
                        new Problem(1, PostKey.SERIES_PART, 3, "series_part is not a whole number from 1 to 1000"));
        assertThat(parsed.values().seriesPart()).isNull();
    }

    @Test
    void an_empty_series_part_is_no_part_and_no_problem() {
        ParsedPost parsed = parse(file("series: S\nseries_part:\n", "x\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().seriesPart()).isNull();
    }

    @Test
    void series_part_without_series_is_a_problem_on_the_series_part_line() {
        ParsedPost parsed = parse(file("title: A\nseries_part: 2\n", "x\n"));

        assertThat(parsed.problems())
                .containsExactly(new Problem(1, PostKey.SERIES_PART, 3, "series_part needs series"));
    }

    @Test
    void series_part_with_an_empty_series_is_a_problem_too() {
        ParsedPost parsed = parse(file("series:\nseries_part: 2\n", "x\n"));

        assertThat(messages(parsed)).containsExactly("series_part needs series");
    }

    @Test
    void series_and_its_description_have_caps_and_a_too_long_series_does_not_add_a_second_problem() {
        String longName = "s".repeat(PostFileLimits.MAX_SERIES_CHARS + 1);
        String longDescription = "d".repeat(PostFileLimits.MAX_SERIES_DESCRIPTION_CHARS + 1);

        ParsedPost parsed = parse(
                file("series: " + longName + "\nseries_part: 1\nseries_description: " + longDescription + "\n", "x\n"));

        assertThat(parsed.problems())
                .containsExactly(
                        new Problem(1, PostKey.SERIES, 2, "the series is longer than 255 characters"),
                        new Problem(
                                1,
                                PostKey.SERIES_DESCRIPTION,
                                4,
                                "the series_description is longer than 2000 characters"));
        assertThat(parsed.values().series()).isNull();
        assertThat(parsed.values().seriesDescription()).isNull();
        assertThat(parsed.values().seriesPart()).isEqualTo(1);
    }

    @Test
    void a_series_key_given_twice_is_a_problem_like_any_key() {
        ParsedPost parsed = parse(file("series: A\nseries: B\nseries_part: 1\n", "x\n"));

        assertThat(messages(parsed)).containsExactly("the key series is given twice; first at line 2");
        assertThat(parsed.values().series()).isEqualTo("A");
    }

    @Test
    void a_file_the_developer_script_accepts_is_valid_input() {
        String text = """
                ---
                # Exported from the admin. "status" is informational only: seed/push.py publishes every file it pushes.
                title: From API Gateway to SQS
                excerpt: Why I chose async.
                category: Architecture
                tags: AWS, Architecture
                featured: true
                status: DRAFT
                ---

                ## Intro

                Paragraph one.
                """;

        ParsedPost parsed = parse("sample-post-11.md", text);

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored()).isEmpty();
        assertThat(parsed.values().title()).isEqualTo("From API Gateway to SQS");
        assertThat(parsed.values().tags()).containsExactly("AWS", "Architecture");
        assertThat(parsed.values().slug()).isEqualTo("sample-post-11");
        assertThat(parsed.slugSource()).isEqualTo(SlugSource.FILE_NAME);
        assertThat(parsed.values().content()).isEqualTo("## Intro\n\nParagraph one.\n");
    }

    @Test
    void featured_and_status_are_read_and_never_a_problem_by_their_value() {
        assertThat(parse(file("title: A\nfeatured: false\nstatus: whatever\n", "x\n"))
                        .problems())
                .isEmpty();
        ParsedPost parsed = parse(file("title: A\nfeatured: False\nstatus: whatever\n", "x\n"));
        assertThat(parsed.values().featured()).isFalse();
        assertThat(parsed.values().status()).isEqualTo("whatever");
    }

    @ParameterizedTest
    @ValueSource(strings = {"yes", "1", "maybe", "truee"})
    void featured_must_be_true_or_false(String value) {
        ParsedPost parsed = parse(file("title: A\nfeatured: " + value + "\n", "x\n"));

        assertThat(parsed.problems())
                .containsExactly(new Problem(1, PostKey.FEATURED, 3, "featured must be true or false"));
        assertThat(parsed.values().featured()).isNull();
    }

    // ---- front matter lines -----------------------------------------------------------------------------------

    @Test
    void comments_and_blank_lines_are_skipped() {
        ParsedPost parsed = parse(file("""
                # a comment
                title: A

                   # an indented comment
                #title: not a key
                  \t
                excerpt: B
                """, "x\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored()).isEmpty();
        assertThat(parsed.values().title()).isEqualTo("A");
        assertThat(parsed.values().excerpt()).isEqualTo("B");
    }

    @Test
    void values_are_trimmed_and_may_contain_colons_and_yaml_looking_text() {
        ParsedPost parsed = parse(file("""
                title:    Java: what I learned   \s
                excerpt: "quoted" and [bracketed] and *starred* & {braced} | piped > folded
                category:\tGuides\t
                """, "x\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().title()).isEqualTo("Java: what I learned");
        assertThat(parsed.values().excerpt())
                .isEqualTo("\"quoted\" and [bracketed] and *starred* & {braced} | piped > folded");
        assertThat(parsed.values().category()).isEqualTo("Guides");
    }

    @Test
    void an_indented_key_is_still_the_key() {
        ParsedPost parsed = parse(file("  title: A\n", "x\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().title()).isEqualTo("A");
    }

    @Test
    void a_value_that_looks_like_a_fence_is_a_value() {
        ParsedPost parsed = parse(file("""
                title: ---
                excerpt: a --- b
                category: -----
                """, "x\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().title()).isEqualTo("---");
        assertThat(parsed.values().excerpt()).isEqualTo("a --- b");
        assertThat(parsed.values().category()).isEqualTo("-----");
        assertThat(parsed.values().content()).isEqualTo("x\n");
    }

    @Test
    void a_closing_fence_may_have_surrounding_spaces_but_four_hyphens_are_not_a_fence() {
        ParsedPost spaced = parse("---\ntitle: A\n  ---  \n\nBody\n");
        assertThat(spaced.problems()).isEmpty();
        assertThat(spaced.values().content()).isEqualTo("Body\n");

        ParsedPost four = parse("---\ntitle: A\n----\n---\nBody\n");
        assertThat(messages(four)).containsExactly(PostMarkdownParser.NOT_KEY_VALUE);
        assertThat(four.values().content()).isEqualTo("Body\n");
    }

    @Test
    void blank_lines_before_the_opening_fence_are_allowed() {
        ParsedPost parsed = parse("\n  \n---\ntitle: A\n---\nBody\n");

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.lines()).containsEntry(PostKey.TITLE, 4);
        assertThat(parsed.values().content()).isEqualTo("Body\n");
    }

    @Test
    void a_file_that_does_not_start_with_front_matter_has_one_problem_and_no_values() {
        ParsedPost parsed = parse("# no front matter\n\ntitle: A\n---\nBody\n");

        assertThat(parsed.problems()).containsExactly(new Problem(1, null, 1, PostMarkdownParser.NO_FRONT_MATTER));
        assertThat(parsed.values().title()).isNull();
        assertThat(parsed.values().content()).isEmpty();
    }

    @Test
    void text_before_the_opening_fence_is_reported_on_its_own_line() {
        ParsedPost parsed = parse("\n\n# text before the fence\n---\ntitle: A\n---\nBody\n");

        assertThat(parsed.problems()).containsExactly(new Problem(1, null, 3, PostMarkdownParser.NO_FRONT_MATTER));
    }

    @Test
    void an_empty_text_has_the_same_problem_on_line_one() {
        assertThat(parse("").problems()).containsExactly(new Problem(1, null, 1, PostMarkdownParser.NO_FRONT_MATTER));
        assertThat(parse("\n  \n").problems())
                .containsExactly(new Problem(1, null, 1, PostMarkdownParser.NO_FRONT_MATTER));
    }

    @Test
    void only_a_file_whose_front_matter_cannot_be_read_at_all_is_unreadable() {
        assertThat(parse("title: A\n\nBody\n").unreadable()).isTrue();
        assertThat(parse("").unreadable()).isTrue();
        assertThat(parse("---\ntitle: A\n\nBody\n").unreadable()).isTrue();
        // A readable file is not unreadable for having no body or a bad value: the import judges those.
        assertThat(parse("---\ntitle: A\n---\n").unreadable()).isFalse();
        assertThat(parse(file("featured: maybe\n", "Body\n")).unreadable()).isFalse();
        assertThat(parse(file("title: A\n", "Body\n")).unreadable()).isFalse();
    }

    @Test
    void a_front_matter_that_is_never_closed_has_one_problem_on_the_opening_line() {
        ParsedPost parsed = parse("\n---\ntitle: A\nexcerpt\nunknown: x\nBody text\n");

        assertThat(parsed.problems()).containsExactly(new Problem(1, null, 2, PostMarkdownParser.NOT_CLOSED));
        assertThat(parsed.values().title()).isNull();
        assertThat(parsed.ignored()).isEmpty();
        assertThat(parsed.values().content()).isEmpty();
    }

    @Test
    void a_line_without_a_colon_is_a_problem_with_its_line() {
        ParsedPost parsed = parse(file("title: A\nnot a key value line\n- a yaml list item\n", "x\n"));

        assertThat(parsed.problems())
                .containsExactly(
                        new Problem(1, null, 3, PostMarkdownParser.NOT_KEY_VALUE),
                        new Problem(1, null, 4, PostMarkdownParser.NOT_KEY_VALUE));
        assertThat(parsed.values().title()).isEqualTo("A");
    }

    @Test
    void a_repeated_key_is_a_problem_with_the_line_and_the_first_value_stays() {
        ParsedPost parsed = parse(file("title: First\nslug: a\ntitle: Second\nslug: b\ntags: x\ntags: y\n", "x\n"));

        assertThat(parsed.problems())
                .containsExactly(
                        new Problem(1, PostKey.TITLE, 4, "the key title is given twice; first at line 2"),
                        new Problem(1, PostKey.SLUG, 5, "the key slug is given twice; first at line 3"),
                        new Problem(1, PostKey.TAGS, 7, "the key tags is given twice; first at line 6"));
        assertThat(parsed.values().title()).isEqualTo("First");
        assertThat(parsed.values().slug()).isEqualTo("a");
        assertThat(parsed.values().tags()).containsExactly("x");
    }

    @Test
    void a_repeated_empty_key_is_still_a_repeat() {
        ParsedPost parsed = parse(file("title: A\nexcerpt:\nexcerpt: B\n", "x\n"));

        assertThat(parsed.problems())
                .containsExactly(new Problem(1, PostKey.EXCERPT, 4, "the key excerpt is given twice; first at line 3"));
        assertThat(parsed.values().excerpt()).isNull();
    }

    @Test
    void empty_keys_leave_the_values_absent_but_are_recorded() {
        ParsedPost parsed = parse("hello.md", file("""
                title:
                slug:
                language:
                excerpt:
                category:
                tags:
                translation_of:
                featured:
                status:
                series:
                series_part:
                series_description:
                cover:
                cover_alt:
                """, "x\n"));

        assertThat(parsed.problems()).isEmpty();
        PostFileValues values = parsed.values();
        assertThat(values.series()).isNull();
        assertThat(values.seriesPart()).isNull();
        assertThat(values.seriesDescription()).isNull();
        assertThat(values.cover()).isNull();
        assertThat(values.coverAlt()).isNull();
        assertThat(values.title()).isNull();
        assertThat(values.language()).isNull();
        assertThat(values.excerpt()).isNull();
        assertThat(values.category()).isNull();
        assertThat(values.tags()).isEmpty();
        assertThat(values.translationOf()).isNull();
        assertThat(values.featured()).isNull();
        assertThat(values.status()).isNull();
        assertThat(parsed.lines()).hasSize(PostKey.values().length);
        // An empty slug key counts as absent: the file name is used.
        assertThat(values.slug()).isEqualTo("hello");
        assertThat(parsed.slugSource()).isEqualTo(SlugSource.FILE_NAME);
    }

    @Test
    void keys_are_matched_exactly() {
        ParsedPost parsed = parse(file("Title: A\ntitle: B\nTAGS: x\n", "x\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().title()).isEqualTo("B");
        assertThat(parsed.values().tags()).isEmpty();
        assertThat(parsed.ignored()).containsExactly(new Ignored("Title", 2), new Ignored("TAGS", 4));
    }

    // ---- unknown keys -----------------------------------------------------------------------------------------

    @Test
    void a_plain_unknown_key_is_named_and_any_other_is_reported_by_its_line_only() {
        String longKey = "k".repeat(33);
        ParsedPost parsed = parse(file("""
                title: A
                languge: en
                my_key-2: x
                my key: with a space
                : no name at all
                tab\tkey: x
                %s: too long
                caf%s: not ascii
                """.formatted(longKey, (char) 0x00E9), "x\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored())
                .containsExactly(
                        new Ignored("languge", 3),
                        new Ignored("my_key-2", 4),
                        new Ignored(null, 5),
                        new Ignored(null, 6),
                        new Ignored(null, 7),
                        new Ignored(null, 8),
                        new Ignored(null, 9));
        assertThat(parsed.ignoredTotal()).isEqualTo(7);
    }

    @Test
    void a_key_of_exactly_32_plain_characters_is_named() {
        String key = "k".repeat(PostFileLimits.MAX_ECHOED_KEY_CHARS);

        assertThat(parse(file("title: A\n" + key + ": x\n", "x\n")).ignored()).containsExactly(new Ignored(key, 3));
    }

    @Test
    void ignored_keys_are_listed_up_to_the_cap_and_all_are_counted() {
        StringBuilder front = new StringBuilder("title: A\n");
        for (int i = 0; i < 60; i++) {
            front.append("extra").append(i).append(": x\n");
        }

        ParsedPost parsed = parse(file(front.toString(), "x\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored()).hasSize(PostFileLimits.MAX_IGNORED);
        assertThat(parsed.ignoredTotal()).isEqualTo(60);
        assertThat(parsed.ignored().getFirst()).isEqualTo(new Ignored("extra0", 3));
    }

    // ---- value caps -------------------------------------------------------------------------------------------

    @Test
    void values_at_their_limits_are_accepted() {
        ParsedPost parsed = parse(file(
                """
                title: %s
                slug: %s
                category: %s
                language: abcdefgh
                tags: %s, b
                translation_of: %s
                """.formatted("t".repeat(255), "s".repeat(255), "c".repeat(255), "g".repeat(100), "x".repeat(255)),
                "x\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().title()).hasSize(255);
        assertThat(parsed.values().slug()).hasSize(255);
        assertThat(parsed.values().category()).hasSize(255);
        assertThat(parsed.values().tags()).hasSize(2);
    }

    @ParameterizedTest
    @CsvSource({
        "title, 256, the title is longer than 255 characters",
        "slug, 256, the slug is longer than 255 characters",
        "category, 256, the category is longer than 255 characters",
        "language, 9, the language is longer than 8 characters",
        "translation_of, 256, the translation_of is longer than 255 characters"
    })
    void a_value_over_its_limit_is_a_problem_and_is_not_read(String key, int length, String message) {
        ParsedPost parsed = parse(file(key + ": " + "v".repeat(length) + "\n", "x\n"));

        PostKey postKey = PostKey.byName(key);
        assertThat(parsed.problems()).containsExactly(new Problem(1, postKey, 2, message));
        PostFileValues values = parsed.values();
        assertThat(
                        switch (postKey) {
                            case TITLE -> values.title() == null;
                            case CATEGORY -> values.category() == null;
                            case LANGUAGE -> values.language() == null;
                            case TRANSLATION_OF -> values.translationOf() == null;
                            default -> values.slug() == null;
                        })
                .isTrue();
    }

    @Test
    void a_tag_over_100_characters_is_a_problem() {
        ParsedPost parsed = parse(file("tags: ok, " + "t".repeat(101) + "\n", "x\n"));

        assertThat(parsed.problems())
                .containsExactly(new Problem(1, PostKey.TAGS, 2, "a tag is longer than 100 characters"));
        assertThat(parsed.values().tags()).isEmpty();
    }

    @Test
    void twenty_tags_are_accepted_and_twenty_one_are_a_problem() {
        String twenty = String.join(", ", Collections.nCopies(20, "tag"));

        assertThat(parse(file("tags: " + twenty + "\n", "x\n")).values().tags()).hasSize(20);

        ParsedPost parsed = parse(file("tags: " + twenty + ", more\n", "x\n"));
        assertThat(parsed.problems()).containsExactly(new Problem(1, PostKey.TAGS, 2, "there are more than 20 tags"));
        assertThat(parsed.values().tags()).isEmpty();
    }

    @Test
    void a_front_matter_line_over_4000_characters_is_a_problem_naming_a_known_key() {
        ParsedPost parsed =
                parse(file("title: A\nexcerpt: " + "e".repeat(4_000) + "\n# " + "c".repeat(4_000) + "\n", "x\n"));

        assertThat(parsed.problems())
                .containsExactly(
                        new Problem(1, PostKey.EXCERPT, 3, "the line is longer than 4000 characters"),
                        new Problem(1, null, 4, "the line is longer than 4000 characters"));
        assertThat(parsed.values().excerpt()).isNull();
    }

    @Test
    void a_blank_front_matter_line_over_4000_characters_is_a_problem_too() {
        ParsedPost parsed = parse(file("title: A\n" + " ".repeat(4_001) + "\n", "x\n"));

        assertThat(parsed.problems())
                .containsExactly(new Problem(1, null, 3, "the line is longer than 4000 characters"));
    }

    @Test
    void a_front_matter_line_of_exactly_4000_characters_is_accepted() {
        // A comment line carries the length: no key has a value cap as large as the line cap since the excerpt got one
        // (issue 013).
        String comment = "# " + "c".repeat(PostFileLimits.MAX_FRONT_MATTER_LINE_CHARS - "# ".length());

        ParsedPost parsed = parse(file("title: A\n" + comment + "\n", "x\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().title()).isEqualTo("A");
    }

    @Test
    void an_excerpt_over_1000_characters_is_a_problem_and_is_not_read_but_1000_is_accepted() {
        ParsedPost atTheLimit = parse(file("excerpt: " + "e".repeat(PostFileLimits.MAX_EXCERPT_CHARS) + "\n", "x\n"));
        ParsedPost over = parse(file("excerpt: " + "e".repeat(PostFileLimits.MAX_EXCERPT_CHARS + 1) + "\n", "x\n"));

        assertThat(atTheLimit.problems()).isEmpty();
        assertThat(atTheLimit.values().excerpt()).hasSize(1_000);
        assertThat(over.problems())
                .containsExactly(new Problem(1, PostKey.EXCERPT, 2, "the excerpt is longer than 1000 characters"));
        assertThat(over.values().excerpt()).isNull();
    }

    @Test
    void the_line_length_counts_characters_not_utf16_units() {
        String emoji = new String(Character.toChars(0x1F600));
        // A comment line carries the length (the excerpt has a value cap of its own since issue 013).
        String comment = "# " + emoji.repeat(PostFileLimits.MAX_FRONT_MATTER_LINE_CHARS - "# ".length());

        assertThat(parse(file("title: A\n" + comment + "\n", "x\n")).problems()).isEmpty();
        assertThat(parse(file("title: A\n" + comment + emoji.repeat(10) + "\n", "x\n"))
                        .problems())
                .hasSize(1);
    }

    @Test
    void a_front_matter_of_100_lines_is_accepted_and_101_lines_are_a_problem_at_the_first_extra_line() {
        String filler = "# comment\n";
        String hundred = "title: A\n" + filler.repeat(PostFileLimits.MAX_FRONT_MATTER_LINES - 1);
        assertThat(parse(file(hundred, "x\n")).problems()).isEmpty();

        ParsedPost parsed = parse(file(hundred + "\n", "x\n\n"));
        assertThat(parsed.problems())
                .containsExactly(new Problem(1, null, 102, "the front matter has more than 100 lines"));
        assertThat(parsed.values().content()).isEqualTo("x\n\n");
    }

    @Test
    void keys_past_the_front_matter_line_cap_are_not_read() {
        String front = "# c\n".repeat(PostFileLimits.MAX_FRONT_MATTER_LINES) + "title: Late\nunknown: x\n";

        ParsedPost parsed = parse(file(front, "x\n"));

        assertThat(messages(parsed)).containsExactly("the front matter has more than 100 lines");
        assertThat(parsed.values().title()).isNull();
        assertThat(parsed.ignored()).isEmpty();
    }

    @Test
    void problems_are_listed_up_to_the_cap_and_the_last_one_says_more_were_found() {
        // Every line is a problem; 100 lines are read, so exactly the cap of problems is reached without a marker.
        String hundred = "no colon here\n".repeat(PostFileLimits.MAX_FRONT_MATTER_LINES);
        ParsedPost exact = parse(file(hundred, "x\n"));
        assertThat(exact.problems()).hasSize(PostFileLimits.MAX_PROBLEMS);
        assertThat(messages(exact)).containsOnly(PostMarkdownParser.NOT_KEY_VALUE);

        // One more problem than the cap: the front matter cap is one, plus a long slug from the file name.
        ParsedPost over =
                PostMarkdownParser.parse(1, "a".repeat(300) + ".md", file(hundred + "no colon either\n", "x\n"));
        assertThat(over.problems()).hasSize(PostFileLimits.MAX_PROBLEMS);
        assertThat(over.problems().getLast())
                .isEqualTo(new Problem(1, null, null, "more problems were found; only the first 99 are listed"));
    }

    // ---- translation_of ---------------------------------------------------------------------------------------

    @Test
    void translation_of_is_normalised_like_a_slug() {
        ParsedPost parsed = parse(file("translation_of:  Hello  World!  \n", "x\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().translationOf()).isEqualTo("hello-world");
    }

    @Test
    void a_translation_of_without_a_usable_slug_is_a_problem() {
        ParsedPost parsed = parse(file("translation_of: ???\n", "x\n"));

        assertThat(parsed.problems())
                .containsExactly(new Problem(1, PostKey.TRANSLATION_OF, 2, "translation_of is not a usable slug"));
        assertThat(parsed.values().translationOf()).isNull();
    }

    // ---- slug -------------------------------------------------------------------------------------------------

    @Test
    void the_slug_key_comes_first_then_the_file_name_then_the_title() {
        ParsedPost key = parse("file-name.md", file("title: The Title\nslug: from-key\n", "x\n"));
        assertThat(key.values().slug()).isEqualTo("from-key");
        assertThat(key.slugSource()).isEqualTo(SlugSource.KEY);

        ParsedPost name = parse("file-name.md", file("title: The Title\n", "x\n"));
        assertThat(name.values().slug()).isEqualTo("file-name");
        assertThat(name.slugSource()).isEqualTo(SlugSource.FILE_NAME);

        ParsedPost title = parse(null, file("title: The Title\n", "x\n"));
        assertThat(title.values().slug()).isEqualTo("the-title");
        assertThat(title.slugSource()).isEqualTo(SlugSource.TITLE);
    }

    @Test
    void a_slug_that_normalises_to_empty_counts_as_absent() {
        ParsedPost parsed = parse("kept.md", file("title: A\nslug: ???\n", "x\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().slug()).isEqualTo("kept");
        assertThat(parsed.slugSource()).isEqualTo(SlugSource.FILE_NAME);
        assertThat(parsed.lines()).containsEntry(PostKey.SLUG, 3);
    }

    @ParameterizedTest
    @CsvSource(delimiter = '|', textBlock = """
            My Post.MD            | my-post
            dir/sub/Hello World.md| hello-world
            C:\\Users\\x\\Notes_2026.md | notes-2026
            a.b.md                | a-b
            UPPER.md              | upper
            """)
    void the_file_name_is_a_slug_without_its_path_and_extension(String fileName, String expected) {
        ParsedPost parsed = parse(fileName, file("title: Different\n", "x\n"));

        assertThat(parsed.values().slug()).isEqualTo(expected);
        assertThat(parsed.slugSource()).isEqualTo(SlugSource.FILE_NAME);
    }

    @ParameterizedTest
    @ValueSource(strings = {".md", "   .md", "???.md", ""})
    void a_file_name_without_a_usable_stem_falls_back_to_the_title(String fileName) {
        ParsedPost parsed = parse(fileName, file("title: Some Title\n", "x\n"));

        assertThat(parsed.values().slug()).isEqualTo("some-title");
        assertThat(parsed.slugSource()).isEqualTo(SlugSource.TITLE);
    }

    @Test
    void without_a_title_the_slug_is_untitled() {
        ParsedPost parsed = parse(null, file("excerpt: only an excerpt\n", "x\n"));

        assertThat(parsed.values().slug()).isEqualTo("untitled");
        assertThat(parsed.slugSource()).isEqualTo(SlugSource.TITLE);
    }

    @Test
    void the_slug_goes_through_the_editor_normalisation_whatever_its_source() {
        ParsedPost parsed = parse(file("slug: Hello,  World -- Again!\n", "x\n"));

        assertThat(parsed.values().slug()).isEqualTo("hello-world-again");
        assertThat(parsed.slugSource()).isEqualTo(SlugSource.KEY);
    }

    @Test
    void a_slug_key_that_is_too_long_is_a_problem_and_does_not_fall_back_to_the_file_name() {
        ParsedPost parsed = parse("name.md", file("title: A\nslug: " + "s".repeat(256) + "\n", "x\n"));

        assertThat(parsed.problems())
                .containsExactly(new Problem(1, PostKey.SLUG, 3, "the slug is longer than 255 characters"));
        assertThat(parsed.values().slug()).isNull();
        assertThat(parsed.slugSource()).isNull();
    }

    @Test
    void a_file_name_that_makes_a_slug_over_255_characters_is_a_problem() {
        ParsedPost parsed = parse("n".repeat(256) + ".md", file("title: A\n", "x\n"));

        assertThat(parsed.problems())
                .containsExactly(new Problem(1, PostKey.SLUG, null, "the slug is longer than 255 characters"));
        assertThat(parsed.values().slug()).isNull();
    }

    @Test
    void the_position_is_on_every_problem() {
        ParsedPost parsed = PostMarkdownParser.parse(7, "post.md", file("title: A\ntitle: B\nnope\n", "x\n"));

        assertThat(parsed.position()).isEqualTo(7);
        assertThat(parsed.problems()).hasSize(2).extracting(Problem::position).containsOnly(7);
    }

    // ---- body -------------------------------------------------------------------------------------------------

    @Test
    void the_body_starts_at_the_first_non_blank_line_and_keeps_everything_after_it() {
        ParsedPost parsed = parse("---\ntitle: A\n---\n\n   \n\t\n    indented code\n\nNext\n\n\n");

        assertThat(parsed.values().content()).isEqualTo("    indented code\n\nNext\n\n\n");
        assertThat(parsed.bodyLine()).isEqualTo(7);
    }

    @Test
    void a_body_right_after_the_fence_without_a_blank_line_is_read() {
        ParsedPost parsed = parse("---\ntitle: A\n---\nBody\n");

        assertThat(parsed.values().content()).isEqualTo("Body\n");
        assertThat(parsed.bodyLine()).isEqualTo(4);
    }

    @Test
    void a_body_without_a_trailing_newline_is_kept_as_it_is() {
        assertThat(parse(file("title: A\n", "No newline at the end")).values().content())
                .isEqualTo("No newline at the end");
    }

    @Test
    void a_fence_and_front_matter_text_inside_the_body_stay_in_the_body() {
        String body = "Above\n\n---\n\ntitle: not a key\n\n```yaml\n---\nkey: v\n---\n```\n";

        ParsedPost parsed = parse(file("title: A\n", body));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored()).isEmpty();
        assertThat(parsed.values().content()).isEqualTo(body);
    }

    @Test
    void a_file_without_a_body_has_empty_content_and_no_body_line() {
        assertThat(parse("---\ntitle: A\n---\n").values().content()).isEmpty();
        assertThat(parse("---\ntitle: A\n---\n").bodyLine()).isZero();
        assertThat(parse("---\ntitle: A\n---").values().content()).isEmpty();
        assertThat(parse("---\ntitle: A\n---\n\n  \n\n").values().content()).isEmpty();
    }

    @Test
    void a_body_may_have_a_very_long_line() {
        String line = "word ".repeat(100_000);

        ParsedPost parsed = parse(file("title: A\n", line + "\nend\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().content()).isEqualTo(line + "\nend\n");
    }

    // ---- through the decoder ----------------------------------------------------------------------------------

    private static ParsedPost decodeAndParse(String text) {
        return parse(PostFile.decode(text.getBytes(StandardCharsets.UTF_8)));
    }

    @Test
    void bom_crlf_and_cr_give_the_same_result_as_lf() {
        String text = file("title: A\ntags: a, b\n\n# c\nexcerpt: E\n", "One\n\nTwo\n");

        ParsedPost lf = decodeAndParse(text);
        ParsedPost crlf = decodeAndParse((char) 0xFEFF + text.replace("\n", "\r\n"));
        ParsedPost cr = decodeAndParse(text.replace("\n", "\r"));

        assertThat(lf.problems()).isEmpty();
        assertThat(crlf).isEqualTo(lf);
        assertThat(cr).isEqualTo(lf);
        assertThat(lf.lines()).containsEntry(PostKey.EXCERPT, 6);
    }

    @Test
    void nfc_and_nfd_give_the_same_result() {
        String composed = file(
                "title: Cafe" + (char) 0x00E9 + "\ncategory: Cr" + (char) 0x00E8 + "me\n",
                "Caf" + (char) 0x00E9 + "\n");
        String decomposed = Normalizer.normalize(composed, Normalizer.Form.NFD);
        assertThat(decomposed).isNotEqualTo(composed);

        assertThat(decodeAndParse(decomposed)).isEqualTo(decodeAndParse(composed));
        assertThat(decodeAndParse(decomposed).values().title()).isEqualTo("Cafe" + (char) 0x00E9);
    }

    // ---- the cover keys ---------------------------------------------------------------------------------------

    @Test
    void the_cover_and_its_alt_text_are_read_with_their_lines() {
        ParsedPost parsed = parse(file("title: A\ncover: assets/cover.png\ncover_alt: A red door\n", "Text\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored()).isEmpty();
        assertThat(parsed.values().cover()).isEqualTo("assets/cover.png");
        assertThat(parsed.values().coverAlt()).isEqualTo("A red door");
        assertThat(parsed.lines()).containsEntry(PostKey.COVER, 3).containsEntry(PostKey.COVER_ALT, 4);
    }

    @Test
    void empty_cover_keys_give_nothing() {
        ParsedPost parsed = parse(file("title: A\ncover:\ncover_alt:\n", "Text\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().cover()).isNull();
        assertThat(parsed.values().coverAlt()).isNull();
    }

    @Test
    void a_cover_alt_text_longer_than_the_media_limit_is_a_problem_of_its_key() {
        String longAlt = "a".repeat(com.blog.media.entity.Media.ALT_TEXT_MAX_LENGTH + 1);

        ParsedPost parsed = parse(file("title: A\ncover: assets/c.png\ncover_alt: " + longAlt + "\n", "Text\n"));

        assertThat(parsed.problems()).extracting(Problem::key).containsExactly(PostKey.COVER_ALT);
        assertThat(parsed.values().coverAlt()).isNull();
    }
}
