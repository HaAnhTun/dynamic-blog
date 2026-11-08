package com.blog.postimport.format;

import static com.blog.support.ZipPackages.zip;
import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.blog.postimport.format.PostPackageRefs.Kind;
import com.blog.postimport.format.PostPackageRefs.Ref;
import com.blog.support.ZipPackages.Builder;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * The example article packages of {@code fixtures/article-packages/}: each folder, zipped the way the build script zips it, is a
 * package the reader accepts, with a post file the parser accepts, images that all exist and are all used, and nothing unsafe.
 */
class PostPackageFixturesTest {

    private static final Path FIXTURES = Path.of("..", "fixtures", "article-packages");
    private static final Path BUILD_SCRIPT = Path.of("..", "scripts", "fixtures", "build-article-zips.mjs");
    private static final long BUDGET = PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES;

    static Stream<String> packages() throws IOException {
        try (Stream<Path> folders = Files.list(FIXTURES)) {
            List<String> names = folders.filter(folder -> Files.exists(folder.resolve("article.md")))
                    .map(folder -> folder.getFileName().toString())
                    .sorted()
                    .toList();
            assertThat(names)
                    .contains(
                            "a-architecture", "b-tutorial", "c-concept", "d-case-study", "f-variants", "g-postmortem");
            return names.stream();
        }
    }

    /** The package of a fixture folder: article.md at the root, then the files under assets/. */
    private static byte[] zipOf(String name) throws IOException {
        Path folder = FIXTURES.resolve(name);
        Builder builder = zip().add("article.md", Files.readAllBytes(folder.resolve("article.md")));
        Path assets = folder.resolve("assets");
        if (Files.isDirectory(assets)) {
            try (Stream<Path> files = Files.walk(assets)) {
                for (Path file : files.filter(Files::isRegularFile).sorted().toList()) {
                    String entry = folder.relativize(file).toString().replace((char) 92, '/');
                    builder.add(entry, Files.readAllBytes(file));
                }
            }
        }
        return builder.build();
    }

    private static Set<String> assetPaths(PostPackage pack) {
        Set<String> paths = new TreeSet<>();
        pack.assets().forEach(asset -> paths.add(asset.path()));
        return paths;
    }

    @ParameterizedTest
    @MethodSource("packages")
    void a_built_package_is_read_without_problems(String name) throws IOException {
        PostPackage pack = PostPackageReader.read(zipOf(name), BUDGET);

        assertThat(pack.readable()).isTrue();
        assertThat(pack.problems()).isEmpty();
        assertThat(pack.unsupportedItems()).isZero();
        assertThat(pack.assets()).allSatisfy(asset -> assertThat(asset.format()).isNotNull());
    }

    @ParameterizedTest
    @MethodSource("packages")
    void the_article_is_a_post_file_with_a_demo_slug(String name) throws IOException {
        PostPackage pack = PostPackageReader.read(zipOf(name), BUDGET);

        ParsedPost post = PostMarkdownParser.parse(1, "article.md", pack.markdown());

        assertThat(post.problems()).isEmpty();
        assertThat(post.slugSource()).isEqualTo(SlugSource.KEY);
        assertThat(post.values().slug()).startsWith("blocks-demo-");
        assertThat(post.values().title()).isNotBlank();
        assertThat(post.values().category()).isNotBlank();
        assertThat(post.values().tags()).isNotEmpty();
        assertThat(post.values().content()).isNotBlank();
    }

    @ParameterizedTest
    @MethodSource("packages")
    void every_image_the_article_names_is_in_the_package_and_every_image_is_named(String name) throws IOException {
        PostPackage pack = PostPackageReader.read(zipOf(name), BUDGET);
        ParsedPost post = PostMarkdownParser.parse(1, "article.md", pack.markdown());

        PostPackageRefs.Scan scan = PostPackageRefs.scan(post.values().content());
        Set<String> named = new TreeSet<>();
        for (Ref ref : scan.refs()) {
            PostPackageRefs.Target target = PostPackageRefs.resolve(ref.raw());
            if (target.kind() == Kind.LOCAL) {
                named.add(target.path());
            } else {
                assertThat(ref.image())
                        .as("a remote or escaping image reference")
                        .isFalse();
            }
        }

        assertThat(scan.unsafe()).isEmpty();
        assertThat(named).isEqualTo(assetPaths(pack));
    }

    @Test
    void the_four_articles_ship_different_numbers_of_images() throws IOException {
        List<Integer> counts = new ArrayList<>();
        for (String name : List.of("a-architecture", "b-tutorial", "c-concept", "d-case-study")) {
            counts.add(PostPackageReader.read(zipOf(name), BUDGET).assets().size());
        }

        assertThat(counts).containsExactly(1, 4, 0, 2);
    }

    @Test
    void the_variants_article_ships_its_gallery_tiles_and_its_wide_chart() throws IOException {
        PostPackage pack = PostPackageReader.read(zipOf("f-variants"), BUDGET);

        assertThat(assetPaths(pack))
                .containsExactly(
                        "assets/tile-1.png", "assets/tile-2.png", "assets/tile-3.png", "assets/wide-chart.png");
    }

    @Test
    void the_postmortem_ships_no_images_and_is_an_english_article_of_its_own() throws IOException {
        PostPackage pack = PostPackageReader.read(zipOf("g-postmortem"), BUDGET);

        ParsedPost post = PostMarkdownParser.parse(1, "article.md", pack.markdown());

        assertThat(pack.assets()).isEmpty();
        assertThat(post.problems()).isEmpty();
        assertThat(post.values().slug()).isEqualTo("blocks-demo-postmortem");
        assertThat(post.values().language()).isEqualTo("en");
    }

    @Test
    void the_packages_the_node_script_writes_read_the_same_as_the_ones_built_here(@TempDir Path out) throws Exception {
        assumeTrue(nodeAvailable(), "node is not installed");
        Process build = new ProcessBuilder("node", BUILD_SCRIPT.toString(), out.toString())
                .redirectErrorStream(true)
                .start();
        String output = new String(build.getInputStream().readAllBytes());
        assertThat(build.waitFor(60, TimeUnit.SECONDS)).isTrue();
        assertThat(build.exitValue()).as(output).isZero();

        List<String> names = packages().toList();
        for (String name : names) {
            PostPackage fromNode = PostPackageReader.read(Files.readAllBytes(out.resolve(name + ".zip")), BUDGET);
            PostPackage fromJava = PostPackageReader.read(zipOf(name), BUDGET);

            assertThat(fromNode.problems()).as(name).isEmpty();
            assertThat(fromNode.markdown()).as(name).isEqualTo(fromJava.markdown());
            assertThat(assetPaths(fromNode)).as(name).isEqualTo(assetPaths(fromJava));
            assertThat(fromNode.unpackedBytes()).as(name).isEqualTo(fromJava.unpackedBytes());
        }
    }

    private static boolean nodeAvailable() {
        try {
            Process probe = new ProcessBuilder("node", "--version")
                    .redirectErrorStream(true)
                    .start();
            probe.getInputStream().readAllBytes();
            return probe.waitFor(30, TimeUnit.SECONDS) && probe.exitValue() == 0;
        } catch (IOException | InterruptedException e) {
            return false;
        }
    }
}
