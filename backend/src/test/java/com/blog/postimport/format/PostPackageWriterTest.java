package com.blog.postimport.format;

import static com.blog.support.ZipPackages.image;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The writer is the inverse of the reader: what it writes the reader reads back. No Spring, no database. */
class PostPackageWriterTest {

    private static final String ONE = "11111111-1111-4111-8111-111111111111.png";
    private static final String TWO = "22222222-2222-4222-8222-222222222222.jpg";

    private final Map<String, PostPackageWriter.Image> store = new HashMap<>();

    private PostFileValues post(String content) {
        return new PostFileValues(
                "A post",
                "a-post",
                "en",
                "An excerpt.",
                "Architecture",
                List.of("AWS", "SQS"),
                false,
                "DRAFT",
                null,
                content);
    }

    private PostFileValues inSeries(String content) {
        return new PostFileValues(
                "A post",
                "a-post",
                "en",
                "An excerpt.",
                "Architecture",
                List.of("AWS"),
                false,
                "DRAFT",
                null,
                "Queues",
                2,
                "All about queues.",
                content);
    }

    private byte[] export(PostFileValues values) {
        return PostPackageWriter.write(values, store::get);
    }

    private PostPackage read(byte[] zip) {
        PostPackage pack = PostPackageReader.read(zip, PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);
        assertThat(pack.problems()).isEmpty();
        assertThat(pack.markdown()).isNotNull();
        return pack;
    }

    private void put(String file, byte[] data, String alt, String original) {
        store.put(file, new PostPackageWriter.Image(data, alt, original));
    }

    @Test
    void a_post_without_images_is_a_package_of_one_article_the_reader_reads_back() {
        PostFileValues values = post("## Intro\n\nJust text.\n");

        PostPackage pack = read(export(values));

        assertThat(pack.assets()).isEmpty();
        assertThat(pack.entries()).isEqualTo(1);
        assertThat(pack.markdown()).isEqualTo(PostMarkdownWriter.write(values));
    }

    @Test
    void the_front_matter_is_the_one_of_the_markdown_writer_plus_the_series_keys_of_a_declared_part() {
        PostFileValues values = inSeries("Body.\n");

        String article = read(export(values)).markdown();

        assertThat(article).isEqualTo(PostMarkdownWriter.write(values));
        assertThat(article)
                .contains("series: Queues\n")
                .contains("series_part: 2\n")
                .contains("series_description: All about queues.\n");
        ParsedPost parsed = PostMarkdownParser.parse(1, "article.md", article);
        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.values().series()).isEqualTo("Queues");
        assertThat(parsed.values().seriesPart()).isEqualTo(2);
        assertThat(parsed.values().seriesDescription()).isEqualTo("All about queues.");
    }

    @Test
    void a_post_in_a_series_without_a_declared_part_gets_no_series_keys() {
        PostFileValues values = new PostFileValues(
                "A post", "a-post", "en", null, null, List.of(), false, "DRAFT", null, "Queues", null, "Text.",
                "Body.\n");

        assertThat(read(export(values)).markdown()).doesNotContain("series");
    }

    @Test
    void the_images_of_the_body_move_into_assets_and_their_references_follow() {
        put(ONE, image("opaque.png"), null, "diagram.png");
        put(TWO, image("orient6.jpg"), "A photo of the harbour", null);
        String content = "Intro.\n\n![Overview of the system](/media/" + ONE + "#640x480)\n\n"
                + ":::figure{src=\"/media/" + TWO + "\" alt=\"Harbour\"}\n:::\n\n"
                + "Again: ![](/media/" + ONE + ")\n";

        PostPackage pack = read(export(post(content)));

        assertThat(pack.assets())
                .extracting(PostPackage.Asset::path)
                .containsExactly("assets/overview-of-the-system-1.png", "assets/harbour-2.jpg");
        assertThat(pack.assets().get(0).data()).isEqualTo(image("opaque.png"));
        assertThat(pack.assets().get(1).data()).isEqualTo(image("orient6.jpg"));
        String body = pack.markdown().substring(pack.markdown().indexOf("\n---\n", 4) + 5);
        assertThat(body)
                .isEqualTo("\nIntro.\n\n![Overview of the system](assets/overview-of-the-system-1.png)\n\n"
                        + ":::figure{src=\"assets/harbour-2.jpg\" alt=\"Harbour\"}\n:::\n\n"
                        + "Again: ![](assets/overview-of-the-system-1.png)\n");
    }

    @Test
    void a_name_comes_from_the_stored_description_or_the_file_name_when_the_body_gives_none() {
        put(ONE, image("opaque.png"), "Stored description", "ignored.png");
        put(TWO, image("orient6.jpg"), null, "Sketch of caf" + (char) 0x00e9 + ".JPG");

        PostPackage pack = read(export(post("![](/media/" + ONE + ")\n\n![](/media/" + TWO + ")\n")));

        assertThat(pack.assets())
                .extracting(PostPackage.Asset::path)
                .containsExactly("assets/stored-description-1.png", "assets/sketch-of-cafe-2.jpg");
    }

    @Test
    void only_the_references_the_import_resolves_are_rewritten() {
        put(ONE, image("opaque.png"), null, null);
        String code = "```markdown\n![in a fence](/media/" + ONE + ")\n```\n";
        String inline = "Inline `![x](/media/" + ONE + ")` code.\n";
        String remote = "![remote](https://example.com/media/" + ONE + ")\n";
        String raw = "<img src=\"/media/" + ONE + "\">\n";
        String other = "![other](/media/not-an-id.png)\n";
        String used = "![used](/media/" + ONE + ")\n";

        PostPackage pack =
                read(export(post(code + "\n" + inline + "\n" + remote + "\n" + raw + "\n" + other + "\n" + used)));

        assertThat(pack.assets()).hasSize(1);
        String article = pack.markdown();
        assertThat(article)
                .contains(code)
                .contains(inline)
                .contains(remote)
                .contains(raw)
                .contains(other);
        assertThat(article).contains("![used](assets/used-1.png)");
        // Exactly the references of the fence, the code span, the remote URL and the raw HTML keep the site path.
        assertThat(article.split("/media/" + ONE, -1)).hasSize(5);
    }

    @Test
    void an_image_that_is_missing_or_not_an_accepted_format_keeps_its_reference() {
        put(TWO, "not an image".getBytes(java.nio.charset.StandardCharsets.UTF_8), null, null);
        String content = "![gone](/media/" + ONE + ")\n\n![broken](/media/" + TWO + ")\n";

        PostPackage pack = read(export(post(content)));

        assertThat(pack.assets()).isEmpty();
        assertThat(pack.markdown()).contains("![gone](/media/" + ONE + ")").contains("![broken](/media/" + TWO + ")");
    }

    @Test
    void an_image_larger_than_an_asset_may_be_keeps_its_reference() {
        byte[] huge = new byte[PostFileLimits.MAX_PACKAGE_ASSET_BYTES + 1];
        System.arraycopy(image("opaque.png"), 0, huge, 0, 16);
        put(ONE, huge, null, null);
        put(TWO, image("orient6.jpg"), null, null);

        PostPackage pack = read(export(post("![big](/media/" + ONE + ")\n\n![small](/media/" + TWO + ")\n")));

        assertThat(pack.assets()).extracting(PostPackage.Asset::path).containsExactly("assets/small-1.jpg");
        assertThat(pack.markdown()).contains("![big](/media/" + ONE + ")");
    }

    @Test
    void images_beyond_the_entry_limit_keep_their_references() {
        StringBuilder content = new StringBuilder();
        List<String> files = new ArrayList<>();
        for (int i = 0; i < PostFileLimits.MAX_PACKAGE_ENTRIES + 3; i++) {
            String file = String.format("%08d-0000-4000-8000-000000000000.png", i);
            files.add(file);
            put(file, image("opaque.png"), null, null);
            content.append("![n").append(i).append("](/media/").append(file).append(")\n\n");
        }

        PostPackage pack = read(export(post(content.toString())));

        assertThat(pack.entries()).isEqualTo(PostFileLimits.MAX_PACKAGE_ENTRIES);
        assertThat(pack.assets()).hasSize(PostFileLimits.MAX_PACKAGE_ENTRIES - 1);
        assertThat(pack.markdown()).contains("/media/" + files.get(files.size() - 1));
    }

    @Test
    void images_that_would_not_fit_the_size_of_a_package_keep_their_references() {
        // Four images of about 1.5 MiB each cannot all be in a package of 4 MiB.
        byte[] big = new byte[1_500_000];
        System.arraycopy(image("opaque.png"), 0, big, 0, 16);
        StringBuilder content = new StringBuilder();
        for (int i = 0; i < 4; i++) {
            String file = "0000000" + i + "-0000-4000-8000-000000000000.png";
            put(file, big, null, null);
            content.append("![i").append(i).append("](/media/").append(file).append(")\n\n");
        }

        byte[] zip = export(post(content.toString()));

        assertThat(zip.length).isLessThanOrEqualTo(PostFileLimits.MAX_PACKAGE_BYTES);
        PostPackage pack = read(zip);
        assertThat(pack.assets()).hasSize(2);
        assertThat(pack.markdown()).contains("/media/00000003-0000-4000-8000-000000000000.png");
    }

    @Test
    void two_exports_of_the_same_post_are_identical_bytes_and_the_article_comes_first() {
        put(ONE, image("opaque.png"), null, null);
        put(TWO, image("orient6.jpg"), null, null);
        PostFileValues values = post("![a](/media/" + ONE + ")\n\n![b](/media/" + TWO + ")\n");

        byte[] first = export(values);

        assertThat(export(values)).isEqualTo(first);
        assertThat(entryNames(first)).containsExactly("article.md", "assets/a-1.png", "assets/b-2.jpg");
    }

    @Test
    void an_article_of_a_repeated_character_is_not_taken_for_a_decompression_bomb() {
        String content = "a".repeat(200_000) + "\n";

        PostPackage pack = read(export(post(content)));

        assertThat(pack.markdown()).endsWith(content);
    }

    @Test
    void a_post_whose_article_exceeds_the_limit_of_the_import_is_refused_with_a_fixed_sentence() {
        String content = "word ".repeat(PostFile.MAX_BYTES / 5 + 10);

        assertThatThrownBy(() -> export(post(content))).isInstanceOfSatisfying(ApiException.class, e -> {
            assertThat(e.getCode()).isEqualTo(ErrorCode.POST_EXPORT_TOO_LARGE);
            assertThat(e.getMessage()).isEqualTo(PostPackageWriter.TOO_LARGE);
        });
    }

    private static List<String> entryNames(byte[] zip) {
        List<String> names = new ArrayList<>();
        try (java.util.zip.ZipInputStream in =
                new java.util.zip.ZipInputStream(new java.io.ByteArrayInputStream(zip))) {
            java.util.zip.ZipEntry entry;
            while ((entry = in.getNextEntry()) != null) {
                names.add(entry.getName());
            }
        } catch (java.io.IOException e) {
            throw new java.io.UncheckedIOException(e);
        }
        return names;
    }

    @Test
    void a_cover_is_written_under_assets_with_an_ascii_name_its_real_extension_and_the_cover_keys() {
        byte[] png = image("opaque.png");
        put(ONE, png, "alt", "x.png");
        PostPackageWriter.Image cover = new PostPackageWriter.Image(png, "A red door", "Cover.jpg");

        byte[] zip = PostPackageWriter.write(post("![Cover](/media/" + ONE + ")\n"), store::get, cover);

        PostPackage pack = read(zip);
        assertThat(pack.markdown()).contains("\ncover: assets/cover-2.png\n").contains("\ncover_alt: A red door\n");
        assertThat(pack.assets())
                .extracting(PostPackage.Asset::path)
                .containsExactly("assets/cover-1.png", "assets/cover-2.png");
    }

    @Test
    void a_cover_that_is_not_an_image_or_is_missing_leaves_the_cover_keys_out() {
        PostPackageWriter.Image notAnImage = new PostPackageWriter.Image("text".getBytes(), null, null);

        for (PostPackageWriter.Image cover : new PostPackageWriter.Image[] {null, notAnImage}) {
            PostPackage pack = read(PostPackageWriter.write(post("Text.\n"), store::get, cover));

            assertThat(pack.markdown()).doesNotContain("cover:");
            assertThat(pack.assets()).isEmpty();
        }
    }
}
