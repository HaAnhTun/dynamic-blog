package com.blog.postimport.format;

import static com.blog.postimport.format.PostMarkdownParserTest.file;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.postimport.format.ParsedPost.Ignored;
import com.blog.postimport.format.ParsedPost.Problem;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpStatus;

/**
 * The file is untrusted: limits hold before and while parsing, nothing of YAML or HTML is interpreted, the work stays linear,
 * and no problem message repeats a value from the file. Ends with a deterministic fuzz over real fragments and garbage.
 */
class PostMarkdownParserSecurityTest {

    private static final String MARK = "QQMARKQQ";
    private static final Pattern PLAIN_WORD = Pattern.compile("[A-Za-z0-9_-]{1,32}");

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static ParsedPost parse(String text) {
        return PostMarkdownParser.parse(1, "post.md", text);
    }

    private static void assertNoEcho(ParsedPost parsed, String marker) {
        assertThat(parsed.problems()).extracting(Problem::message).noneMatch(m -> m.contains(marker));
        assertThat(parsed.problems())
                .extracting(Problem::key)
                .noneMatch(k -> k != null && k.keyName().contains(marker));
    }

    // ---- limits before parsing ---------------------------------------------------------------------------------

    @Test
    void binary_content_is_rejected_by_decode() {
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n', 0, 0, 0, 0x0D};
        assertThatThrownBy(() -> PostFile.decode(png))
                .isInstanceOfSatisfying(
                        ApiException.class, e -> assertThat(e.getCode()).isEqualTo(ErrorCode.POST_IMPORT_INVALID_FILE));
    }

    @Test
    void a_nul_byte_is_rejected_by_decode_with_its_line() {
        byte[] bytes = utf8(file("title: A?B\n", "Body\n"));
        bytes[bytes.length - 3] = 0;
        assertThatThrownBy(() -> PostFile.decode(bytes)).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(ErrorCode.POST_IMPORT_INVALID_FILE);
            assertThat(e.getMessage()).contains("line 5").doesNotContain("Body");
        });
    }

    @Test
    void an_oversized_file_is_rejected_with_413_before_parsing() {
        byte[] bytes = utf8(file("title: A\n", "a".repeat(PostFile.MAX_BYTES)));
        assertThatThrownBy(() -> PostFile.decode(bytes)).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(ErrorCode.VALIDATION_ERROR);
            assertThat(e.getStatus()).isEqualTo(HttpStatus.CONTENT_TOO_LARGE);
        });
    }

    // ---- linear work -------------------------------------------------------------------------------------------

    @Test
    void a_full_size_body_of_one_line_parses_fast() {
        String body = "x".repeat(PostFile.MAX_BYTES - 100);
        String text = PostFile.decode(utf8(file("title: A\n", body)));

        ParsedPost parsed = assertTimeoutPreemptively(Duration.ofSeconds(3), () -> parse(text));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().content()).isEqualTo(body);
    }

    @Test
    void a_full_size_file_of_blank_lines_before_the_body_parses_fast() {
        String text = PostFile.decode(utf8("---\ntitle: A\n---\n" + "\n".repeat(PostFile.MAX_BYTES - 200) + "Body\n"));

        ParsedPost parsed = assertTimeoutPreemptively(Duration.ofSeconds(3), () -> parse(text));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().content()).isEqualTo("Body\n");
    }

    @Test
    void a_full_size_front_matter_gives_one_cap_problem_and_stays_fast() {
        StringBuilder text = new StringBuilder("---\n");
        while (text.length() + 4 <= PostFile.MAX_BYTES) {
            text.append("a: b\n");
        }
        text.append("---\nBody\n");

        ParsedPost parsed = assertTimeoutPreemptively(Duration.ofSeconds(3), () -> parse(text.toString()));

        assertThat(parsed.problems())
                .containsExactly(new Problem(1, null, 102, "the front matter has more than 100 lines"));
        assertThat(parsed.ignoredTotal()).isEqualTo(PostFileLimits.MAX_FRONT_MATTER_LINES);
        assertThat(parsed.ignored()).hasSize(PostFileLimits.MAX_IGNORED);
    }

    @Test
    void a_front_matter_that_never_closes_in_a_full_size_file_stays_fast() {
        String text = "---\ntitle: A\n" + "line of the body\n".repeat(PostFile.MAX_BYTES / 17 - 2);

        ParsedPost parsed = assertTimeoutPreemptively(Duration.ofSeconds(3), () -> parse(text));

        assertThat(parsed.problems()).extracting(Problem::message).containsExactly(PostMarkdownParser.NOT_CLOSED);
    }

    @Test
    void a_three_million_character_front_matter_line_is_one_problem_and_fast() {
        String text = file("title: A\nexcerpt: " + "x".repeat(3_000_000) + "\n", "Body\n");

        ParsedPost parsed = assertTimeoutPreemptively(Duration.ofSeconds(3), () -> parse(text));

        assertThat(parsed.problems())
                .containsExactly(new Problem(1, PostKey.EXCERPT, 3, "the line is longer than 4000 characters"));
    }

    @Test
    void long_lines_full_of_special_characters_parse_in_linear_time() {
        String nasty = ",---".repeat(900) + ":: --- ::" + "#".repeat(300);
        StringBuilder front = new StringBuilder("title: A\n");
        for (int i = 0; i < 20; i++) {
            front.append("tags: ").append(nasty).append('\n');
            front.append(nasty).append('\n');
            front.append("# ").append(nasty).append('\n');
        }
        String text = file(front.toString(), nasty + "\n".repeat(50) + "---\n" + nasty);

        ParsedPost parsed = assertTimeoutPreemptively(Duration.ofSeconds(3), () -> parse(text));

        assertThat(parsed.problems()).isNotEmpty();
        assertThat(parsed.values().content()).startsWith(",---");
    }

    @Test
    void a_file_of_empty_tags_gives_no_tags_and_stays_fast() {
        String text = file("tags: " + ",".repeat(3_900) + "\n", "x\n");

        ParsedPost parsed = assertTimeoutPreemptively(Duration.ofSeconds(3), () -> parse(text));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().tags()).isEmpty();
    }

    // ---- inert text --------------------------------------------------------------------------------------------

    @Test
    void html_and_script_text_stay_inert_text() {
        String script = "<script>alert(1)</script>";
        String image = "<img src=x onerror=alert(1)> and <!-- not a comment -->";

        ParsedPost parsed = parse(file("title: " + script + "\nexcerpt: " + image + "\n", image + "\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().title()).isEqualTo(script);
        assertThat(parsed.values().excerpt()).isEqualTo(image);
        assertThat(parsed.values().content()).isEqualTo(image + "\n");
    }

    @Test
    void forged_keys_cannot_set_anything_outside_the_format() {
        ParsedPost parsed = parse(file("""
                title: A
                author: someone
                author_id: 1
                role: ADMIN
                id: 5
                published_at: 2020-01-01
                playlist: Mine
                thumbnail: /media/x.png
                __proto__: x
                hero/headline: x
                """, "x\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignoredTotal()).isEqualTo(9);
        assertThat(parsed.values())
                .isEqualTo(new PostFileValues("A", "post", null, null, null, List.of(), null, null, null, "x\n"));
    }

    // ---- YAML is never interpreted -----------------------------------------------------------------------------

    @ParameterizedTest
    @ValueSource(
            strings = {
                "title: &anchor Hello",
                "title: *anchor",
                "title: !!str Hello",
                "title: |",
                "title: >-",
                "title: [a, b]",
                "title: {lang: en}",
                "title: \"Quoted\"",
                "title: 'Quoted'"
            })
    void yaml_features_are_plain_text_in_a_value(String line) {
        ParsedPost parsed = parse(file(line + "\n", "x\n"));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().title()).isEqualTo(line.substring("title: ".length()));
    }

    @ParameterizedTest
    @ValueSource(
            strings = {"<<: *base", "&a title: x", "*a: x", "!tag title: x", "[title]: x", "? title", "- title: x"})
    void yaml_structure_never_sets_a_key(String line) {
        ParsedPost parsed = parse(file("title: A\n" + line + "\n", "x\n"));

        assertThat(parsed.values().title()).isEqualTo("A");
        assertThat(parsed.values().tags()).isEmpty();
        assertThat(parsed.ignored()).extracting(Ignored::name).doesNotContain("title");
    }

    @Test
    void a_second_document_marker_in_the_body_is_not_read() {
        ParsedPost parsed = parse(file("title: A\n", "Text\n---\ntitle: B\n---\nMore\n"));

        assertThat(parsed.values().title()).isEqualTo("A");
        assertThat(parsed.values().content()).isEqualTo("Text\n---\ntitle: B\n---\nMore\n");
    }

    // ---- no echo -----------------------------------------------------------------------------------------------

    @Test
    void problems_never_echo_the_file() {
        ParsedPost parsed = parse(file(
                """
                title: %s
                title: %s
                %s
                tags: %s
                language: %s
                slug: %s
                excerpt: %s
                featured: %s
                translation_of: %s
                %s: x
                category: %s
                """.formatted(
                                MARK.repeat(40),
                                MARK,
                                MARK,
                                MARK.repeat(20) + ", " + MARK.repeat(20),
                                MARK,
                                MARK.repeat(40),
                                "e".repeat(4_000),
                                MARK,
                                "???" + MARK.repeat(40),
                                MARK + " key",
                                MARK.repeat(40)),
                "x\n"));

        assertThat(parsed.problems()).hasSizeGreaterThanOrEqualTo(6);
        assertNoEcho(parsed, MARK);
        assertThat(parsed.ignored()).containsExactly(new Ignored(null, 11));
    }

    @Test
    void the_file_name_never_appears_in_a_problem() {
        ParsedPost parsed = PostMarkdownParser.parse(2, MARK.repeat(40) + ".md", file("title: A\nnope\n", "x\n"));

        assertNoEcho(parsed, MARK);
        assertThat(parsed.problems()).extracting(Problem::position).containsOnly(2);
    }

    // ---- fuzz --------------------------------------------------------------------------------------------------

    private static final List<String> FRAGMENTS = List.of(
            "---",
            "----",
            "title: " + MARK,
            "title: ---",
            "title:",
            "slug: " + MARK,
            "slug: ???",
            "language: en",
            "language: " + MARK.repeat(2),
            "excerpt: a --- b",
            "category: " + MARK,
            "tags: " + MARK + ", b,, c",
            "tags: " + ",".repeat(30),
            "featured: true",
            "featured: " + MARK,
            "status: published",
            "translation_of: " + MARK,
            "translation_of: ???",
            MARK + ": value",
            MARK + " with space: value",
            ": value",
            "<<: *a",
            "- list item",
            "# comment " + MARK,
            "  # indented comment",
            "no colon " + MARK,
            "",
            "   ",
            "```",
            "## Heading " + MARK,
            MARK + " paragraph text",
            "x".repeat(4_100));

    private static final String GARBAGE =
            "#-|\\{}=:<>!-*&`~ \tabcXYZ019" + (char) 0x0110 + (char) 0x2028 + (char) 0xFEFF;

    private static String randomText(Random random) {
        int lines = 1 + random.nextInt(40);
        StringBuilder out = new StringBuilder();
        if (random.nextInt(4) > 0) {
            out.append("---\n");
        }
        for (int i = 0; i < lines; i++) {
            int pieces = 1 + random.nextInt(3);
            for (int p = 0; p < pieces; p++) {
                if (random.nextInt(3) == 0) {
                    int length = random.nextInt(12);
                    for (int c = 0; c < length; c++) {
                        out.append(GARBAGE.charAt(random.nextInt(GARBAGE.length())));
                    }
                } else {
                    out.append(FRAGMENTS.get(random.nextInt(FRAGMENTS.size())));
                }
            }
            out.append('\n');
        }
        return out.toString();
    }

    @ParameterizedTest
    @ValueSource(longs = {1L, 7L, 42L, 2026L})
    void fuzzed_input_never_throws_and_always_respects_the_caps(long seed) {
        Random random = new Random(seed);
        List<String> inputs = new ArrayList<>();
        for (int i = 0; i < 500; i++) {
            inputs.add(randomText(random));
        }
        assertTimeoutPreemptively(Duration.ofSeconds(5), () -> {
            for (String input : inputs) {
                ParsedPost parsed = PostMarkdownParser.parse(3, fileNameFor(input), input);
                assertNoEcho(parsed, MARK);
                assertThat(parsed.problems()).hasSizeLessThanOrEqualTo(PostFileLimits.MAX_PROBLEMS);
                assertThat(parsed.problems())
                        .extracting(Problem::position)
                        .allSatisfy(position -> assertThat(position).isEqualTo(3));
                assertThat(parsed.ignored()).hasSizeLessThanOrEqualTo(PostFileLimits.MAX_IGNORED);
                assertThat(parsed.ignored())
                        .extracting(Ignored::name)
                        .allSatisfy(name -> assertThat(
                                        name == null || PLAIN_WORD.matcher(name).matches())
                                .isTrue());
                PostFileValues values = parsed.values();
                assertThat(values.tags()).hasSizeLessThanOrEqualTo(PostFileLimits.MAX_TAGS);
                assertThat(values.tags()).allSatisfy(tag -> assertThat(tag).hasSizeLessThanOrEqualTo(100));
                assertThat(values.title() == null || values.title().length() <= PostFileLimits.MAX_TITLE_CHARS)
                        .isTrue();
                assertThat(values.slug() == null || values.slug().length() <= PostFileLimits.MAX_SLUG_CHARS)
                        .isTrue();
                assertThat(values.language() == null || values.language().length() <= PostFileLimits.MAX_LANGUAGE_CHARS)
                        .isTrue();
                assertThat(values.slug() == null).isEqualTo(parsed.slugSource() == null);
                assertThat(values.content()).isNotNull();
                parsed.lines().values().forEach(line -> assertThat(line).isPositive());
            }
        });
    }

    /** A file name that varies with the input, so the fuzz also covers the second source of the slug. */
    private static String fileNameFor(String input) {
        return input.length() % 3 == 0 ? null : "name " + input.length() + ".md";
    }
}
