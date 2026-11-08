package com.blog.postimport.format;

import static com.blog.support.ZipPackages.zip;
import static org.assertj.core.api.Assertions.assertThat;

import com.blog.common.util.SlugGenerator;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * The demo series of {@code fixtures/article-packages/}: three parts of one series and a fourth whose series name has accents
 * (under {@code fixtures/vi/}). Each, zipped like the build script zips it, is a package the reader accepts with a post file the
 * parser accepts, and the series keys agree, so that importing the parts in any order builds one series.
 */
class PostPackageSeriesFixturesTest {

    private static final Path FIXTURES = Path.of("..", "fixtures", "article-packages");
    private static final Path ACCENT_FIXTURES = Path.of("..", "fixtures", "vi", "article-packages");
    private static final long BUDGET = PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES;
    private static final List<String> PARTS =
            List.of("series-queues-part-1", "series-queues-part-2", "series-queues-part-3");
    private static final String ACCENTS = "series-queues-accents";

    private static ParsedPost parsed(Path root, String name) throws IOException {
        byte[] archive = zip().add(
                        "article.md", Files.readAllBytes(root.resolve(name).resolve("article.md")))
                .build();
        PostPackage pack = PostPackageReader.read(archive, BUDGET);
        assertThat(pack.readable()).as(name).isTrue();
        assertThat(pack.problems()).as(name).isEmpty();
        assertThat(pack.assets()).as(name).isEmpty();
        ParsedPost post = PostMarkdownParser.parse(1, "article.md", pack.markdown());
        assertThat(post.problems()).as(name).isEmpty();
        return post;
    }

    private static List<PostFileValues> parts() throws IOException {
        return List.of(
                parsed(FIXTURES, PARTS.get(0)).values(),
                parsed(FIXTURES, PARTS.get(1)).values(),
                parsed(FIXTURES, PARTS.get(2)).values());
    }

    @Test
    void the_three_parts_are_packages_that_read_and_parse_without_problems() throws IOException {
        assertThat(parts()).hasSize(3).allSatisfy(values -> {
            assertThat(values.slug()).startsWith("blocks-demo-series-");
            assertThat(values.language()).isEqualTo("en");
            assertThat(values.title()).isNotBlank();
            assertThat(values.category()).isNotBlank();
            assertThat(values.tags()).isNotEmpty();
            assertThat(values.content()).isNotBlank();
        });
    }

    @Test
    void the_three_parts_differ_from_one_another() throws IOException {
        List<PostFileValues> parts = parts();

        assertThat(parts.stream().map(PostFileValues::slug).distinct()).hasSize(3);
        assertThat(parts.stream().map(PostFileValues::title).distinct()).hasSize(3);
        assertThat(parts.stream().map(PostFileValues::content).distinct()).hasSize(3);
    }

    @Test
    void the_three_parts_carry_one_series_name_the_parts_one_to_three_and_the_same_description() throws IOException {
        List<PostFileValues> parts = parts();

        assertThat(parts.stream().map(PostFileValues::series).distinct()).containsExactly("Queues in practice");
        assertThat(parts.stream().map(PostFileValues::seriesPart)).containsExactly(1, 2, 3);
        assertThat(parts.get(0).seriesDescription())
                .isNotBlank()
                .hasSizeLessThanOrEqualTo(PostFileLimits.MAX_SERIES_DESCRIPTION_CHARS);
        // Whichever part is imported first, the series gets its description: every part carries the same line.
        assertThat(parts.stream().map(PostFileValues::seriesDescription).distinct())
                .containsExactly(parts.get(0).seriesDescription());
        assertThat(parts.get(0).series()).hasSizeLessThanOrEqualTo(PostFileLimits.MAX_SERIES_CHARS);
    }

    @Test
    void the_accented_part_is_part_four_of_a_series_with_the_same_web_address() throws IOException {
        PostFileValues fourth = parsed(ACCENT_FIXTURES, ACCENTS).values();

        assertThat(fourth.series()).isNotEqualTo("Queues in practice").isNotEqualToIgnoringCase("Queues in practice");
        assertThat(SlugGenerator.slugifyOrEmpty(fourth.series()))
                .isEqualTo(SlugGenerator.slugifyOrEmpty("Queues in practice"));
        assertThat(fourth.seriesPart()).isEqualTo(4);
        assertThat(fourth.seriesDescription()).isNull();
        assertThat(fourth.slug()).isEqualTo("blocks-demo-series-queues-accents");
        assertThat(fourth.language()).isEqualTo("en");
    }
}
