package com.blog.postimport.format;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assumptions.assumeThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * Keeps {@code docs/post-file-format.md} in line with the parser, like {@code SiteProfileFormatDocTest} does for the profile
 * format. The document has two tables between markers: the keys (the first cell of each row is the key in backticks) and the
 * limits (a label and a number). A key added to {@link PostKey}, or a cap changed in {@link PostFileLimits} or {@link PostFile},
 * fails this test until the document says so.
 */
class PostFileFormatDocTest {

    private static final Path DOC = Path.of("..", "docs", "post-file-format.md");
    private static final Pattern KEY_ROW = Pattern.compile("^\\| `([a-z_]+)` \\|");
    private static final Pattern LIMIT_ROW = Pattern.compile("^\\| ([^|]+?) \\| ([0-9,]+) \\|");

    /** The label of each documented limit and the value the parser enforces. */
    private static Map<String, Integer> limits() {
        Map<String, Integer> limits = new LinkedHashMap<>();
        limits.put("Files per import", PostFileLimits.MAX_FILES);
        limits.put("Bytes per file", PostFile.MAX_BYTES);
        limits.put("Bytes in all files of one import", PostFileLimits.MAX_TOTAL_BYTES);
        limits.put("Lines of front matter", PostFileLimits.MAX_FRONT_MATTER_LINES);
        limits.put("Characters of one front matter line", PostFileLimits.MAX_FRONT_MATTER_LINE_CHARS);
        limits.put("Characters of a title", PostFileLimits.MAX_TITLE_CHARS);
        limits.put("Characters of an excerpt", PostFileLimits.MAX_EXCERPT_CHARS);
        limits.put("Characters of a slug", PostFileLimits.MAX_SLUG_CHARS);
        limits.put("Characters of a category name", PostFileLimits.MAX_CATEGORY_CHARS);
        limits.put("Characters of a tag name", PostFileLimits.MAX_TAG_CHARS);
        limits.put("Characters of a language code", PostFileLimits.MAX_LANGUAGE_CHARS);
        limits.put("Tags per post", PostFileLimits.MAX_TAGS);
        limits.put("Characters of a series name", PostFileLimits.MAX_SERIES_CHARS);
        limits.put("Characters of a series description", PostFileLimits.MAX_SERIES_DESCRIPTION_CHARS);
        limits.put("Highest series part", PostFileLimits.MAX_SERIES_PART);
        limits.put("New series per import", PostFileLimits.MAX_NEW_SERIES);
        limits.put("New categories per import", PostFileLimits.MAX_NEW_CATEGORIES);
        limits.put("New tags per import", PostFileLimits.MAX_NEW_TAGS);
        limits.put("Problems listed per file", PostFileLimits.MAX_PROBLEMS);
        limits.put("Ignored keys listed per file", PostFileLimits.MAX_IGNORED);
        limits.put("Bytes per ZIP package", PostFileLimits.MAX_PACKAGE_BYTES);
        limits.put("Entries per ZIP package", PostFileLimits.MAX_PACKAGE_ENTRIES);
        limits.put("Bytes per image of a package", PostFileLimits.MAX_PACKAGE_ASSET_BYTES);
        limits.put(
                "Unpacked bytes in all packages of one import",
                Math.toIntExact(PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES));
        limits.put("Compression ratio of a package entry", PostFileLimits.MAX_PACKAGE_COMPRESSION_RATIO);
        return limits;
    }

    private static String block(String name) throws IOException {
        String text = Files.readString(DOC, StandardCharsets.UTF_8).replace("\r\n", "\n");
        String begin = "<!-- BEGIN " + name + " -->\n";
        String end = "<!-- END " + name + " -->";
        int start = text.indexOf(begin);
        int stop = text.indexOf(end);
        assertThat(start).as("the BEGIN %s marker", name).isNotNegative();
        assertThat(stop).as("the END %s marker", name).isGreaterThan(start);
        return text.substring(start + begin.length(), stop);
    }

    @Test
    void the_documented_keys_are_the_keys_the_parser_reads() throws IOException {
        assumeThat(Files.isRegularFile(DOC)).as("docs/post-file-format.md").isTrue();

        List<String> documented = new ArrayList<>();
        for (String line : block("KEYS").split("\n")) {
            Matcher row = KEY_ROW.matcher(line);
            if (row.find()) {
                documented.add(row.group(1));
            }
        }

        List<String> parsed =
                Arrays.stream(PostKey.values()).map(PostKey::keyName).toList();
        assertThat(documented)
                .as("docs/post-file-format.md must document exactly the keys of PostKey, in the same order")
                .containsExactlyElementsOf(parsed);
    }

    @Test
    void the_documented_limits_are_the_limits_the_parser_enforces() throws IOException {
        assumeThat(Files.isRegularFile(DOC)).as("docs/post-file-format.md").isTrue();

        Map<String, Integer> documented = new LinkedHashMap<>();
        for (String line : block("LIMITS").split("\n")) {
            Matcher row = LIMIT_ROW.matcher(line);
            if (row.find()) {
                documented.put(row.group(1), Integer.parseInt(row.group(2).replace(",", "")));
            }
        }

        assertThat(documented)
                .as("docs/post-file-format.md must list every limit with the value of the code")
                .containsExactlyInAnyOrderEntriesOf(limits());
    }
}
