package com.blog.postimport.format;

import static com.blog.support.ZipPackages.article;
import static com.blog.support.ZipPackages.asEncrypted;
import static com.blog.support.ZipPackages.asSymlink;
import static com.blog.support.ZipPackages.image;
import static com.blog.support.ZipPackages.replaceAll;
import static com.blog.support.ZipPackages.zip;
import static java.nio.charset.StandardCharsets.UTF_8;
import static org.assertj.core.api.Assertions.assertThat;

import com.blog.media.service.ImageFormat;
import java.util.Arrays;
import java.util.Random;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** Reading a ZIP package: what it makes of a good one, and that every hostile archive is refused with a message that holds nothing of it. */
class PostPackageReaderTest {

    private static final long BUDGET = PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES;
    private static final String MARKER = "Quokka-Marker";
    private static final String ARTICLE = article("Body with ![a](assets/a.png)\n", "title: One");

    private static PostPackage read(byte[] zip) {
        return PostPackageReader.read(zip, BUDGET);
    }

    private static void assertRefused(PostPackage pack, String... messageParts) {
        assertThat(pack.readable()).isFalse();
        assertThat(pack.problems()).hasSize(1);
        assertThat(pack.problems().get(0)).contains(messageParts).doesNotContain(MARKER);
        assertThat(pack.assets()).isEmpty();
    }

    // --- A good package ---------------------------------------------------------------------------------------

    @Test
    void an_article_and_its_images_at_the_top_level_are_read_with_paths_relative_to_the_article() {
        byte[] zip = zip().add("article.md", ARTICLE)
                .folder("assets")
                .add("assets/a.png", image("opaque.png"))
                .add("assets/photo.jpg", image("orient6.jpg"))
                .add("assets/shot.webp", image("alpha.webp"))
                .build();

        PostPackage pack = read(zip);

        assertThat(pack.readable()).isTrue();
        assertThat(pack.problems()).isEmpty();
        assertThat(pack.markdown()).isEqualTo(ARTICLE);
        assertThat(pack.entries()).isEqualTo(5);
        assertThat(pack.assets())
                .extracting(PostPackage.Asset::path)
                .containsExactly("assets/a.png", "assets/photo.jpg", "assets/shot.webp");
        assertThat(pack.assets())
                .extracting(PostPackage.Asset::format)
                .containsExactly(ImageFormat.PNG, ImageFormat.JPEG, ImageFormat.WEBP);
        assertThat(pack.assets().get(0).data()).isEqualTo(image("opaque.png"));
        assertThat(pack.assets()).extracting(PostPackage.Asset::entry).containsExactly(3, 4, 5);
        assertThat(pack.assetBytes())
                .isEqualTo(image("opaque.png").length + image("orient6.jpg").length + image("alpha.webp").length);
        assertThat(pack.unpackedBytes()).isGreaterThan(pack.assetBytes());
    }

    @Test
    void the_one_top_level_folder_holds_the_article_and_its_assets() {
        byte[] zip = zip().add("my-article/article.md", ARTICLE)
                .add("my-article/assets/a.png", image("opaque.png"))
                .build();

        PostPackage pack = read(zip);

        assertThat(pack.readable()).isTrue();
        assertThat(pack.problems()).isEmpty();
        assertThat(pack.assets()).extracting(PostPackage.Asset::path).containsExactly("assets/a.png");
    }

    @Test
    void the_noise_of_a_file_manager_is_skipped_and_a_name_in_nfd_is_read_in_nfc() {
        String composed = "caf\u00e9";
        String decomposed = "cafe\u0301";
        byte[] zip = zip().add("article.md", ARTICLE)
                .add("__MACOSX/._article.md", "noise")
                .add(".DS_Store", "noise")
                .add("assets/" + decomposed + ".png", image("opaque.png"))
                .build();

        PostPackage pack = read(zip);

        assertThat(pack.problems()).isEmpty();
        assertThat(pack.assets()).extracting(PostPackage.Asset::path).containsExactly("assets/" + composed + ".png");
    }

    @Test
    void an_image_in_an_unsupported_format_is_a_problem_of_the_package_that_names_the_supported_ones() {
        byte[] svg = "<?xml version=\"1.0\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>".getBytes(UTF_8);
        byte[] gif = "GIF89a....".getBytes(UTF_8);
        byte[] zip = zip().add("article.md", ARTICLE)
                .add("assets/a.png", image("opaque.png"))
                .add("assets/" + MARKER + ".svg", svg)
                .add("assets/anim.gif", gif)
                .build();

        PostPackage pack = read(zip);

        assertThat(pack.readable()).isTrue();
        assertThat(pack.unsupportedItems()).isEqualTo(2);
        assertThat(pack.problems()).hasSize(2);
        assertThat(pack.problems().get(0)).startsWith("entry 3 is an SVG image").contains("PNG, JPEG or WebP");
        assertThat(pack.problems().get(1))
                .startsWith("entry 4 is not a JPEG, PNG or WebP image")
                .contains("JPEG, PNG or WebP");
        assertThat(pack.problems()).allSatisfy(problem -> assertThat(problem).doesNotContain(MARKER));
        assertThat(pack.assets()).extracting(PostPackage.Asset::format).containsExactly(ImageFormat.PNG, null, null);
    }

    @Test
    void a_file_outside_assets_is_a_problem_of_the_package() {
        byte[] zip = zip().add("article.md", ARTICLE)
                .add("notes-" + MARKER + ".txt", "x")
                .build();

        PostPackage pack = read(zip);

        assertThat(pack.readable()).isTrue();
        assertThat(pack.unsupportedItems()).isEqualTo(1);
        assertThat(pack.problems().get(0))
                .startsWith("entry 2 is not the article")
                .doesNotContain(MARKER);
    }

    @Test
    void an_image_is_taken_by_its_magic_bytes_not_by_its_name() {
        byte[] zip = zip().add("article.md", ARTICLE)
                .add("assets/really-a-jpeg.png", image("orient6.jpg"))
                .build();

        assertThat(read(zip).assets().get(0).format()).isEqualTo(ImageFormat.JPEG);
    }

    // --- Hostile names ----------------------------------------------------------------------------------------

    @ParameterizedTest
    @ValueSource(
            strings = {
                "../" + MARKER + ".png",
                "assets/../../" + MARKER + ".png",
                "/etc/" + MARKER,
                "assets\\" + MARKER + ".png",
                "C:/" + MARKER + ".png",
                "assets/" + MARKER + "\u0000.png",
                "assets/" + MARKER + "\u0007.png",
                "assets/./" + MARKER + ".png",
                "assets//" + MARKER + ".png"
            })
    void an_unsafe_entry_name_refuses_the_package_without_echoing_the_name(String name) {
        byte[] zip =
                zip().add("article.md", ARTICLE).add(name, image("opaque.png")).build();

        assertRefused(read(zip), "entry 2 has an unsafe name");
    }

    @Test
    void a_name_that_is_not_utf8_is_refused() {
        byte[] zip = zip().add("article.md", ARTICLE)
                .add("assets/" + MARKER + "aaa.png", image("opaque.png"))
                .build();
        byte[] from = "aaa".getBytes(UTF_8);
        for (int i = 0; i + from.length <= zip.length; i++) {
            if (Arrays.equals(Arrays.copyOfRange(zip, i, i + from.length), from)) {
                zip[i] = (byte) 0xFF;
            }
        }

        assertRefused(read(zip), "entry 2 has a name that is not valid UTF-8");
    }

    @Test
    void duplicate_names_are_refused_also_after_case_folding_and_unicode_normalization() {
        byte[] sameCase = replaceAll(
                zip().add("article.md", ARTICLE)
                        .add("assets/a.png", image("opaque.png"))
                        .add("assets/b.png", image("opaque.png"))
                        .build(),
                "assets/b.png",
                "assets/a.png");
        byte[] otherCase = zip().add("article.md", ARTICLE)
                .add("assets/Photo.png", image("opaque.png"))
                .add("assets/photo.PNG".replace("PNG", "png"), image("opaque.png"))
                .build();
        byte[] otherForm = zip().add("article.md", ARTICLE)
                .add("assets/caf\u00e9.png", image("opaque.png"))
                .add("assets/cafe\u0301.png", image("opaque.png"))
                .build();

        assertRefused(read(sameCase), "entries 2 and 3 have the same name");
        assertRefused(read(otherCase), "entries 2 and 3 have the same name");
        assertRefused(read(otherForm), "entries 2 and 3 have the same name");
    }

    // --- Hostile entries --------------------------------------------------------------------------------------

    @Test
    void a_symbolic_link_is_refused() {
        byte[] zip = zip().add("article.md", ARTICLE)
                .add("assets/a.png", "/etc/passwd")
                .build();

        assertRefused(read(asSymlink(zip, 1)), "entry 2 is a link or a special file");
    }

    @Test
    void an_encrypted_entry_is_refused() {
        byte[] zip = zip().add("article.md", ARTICLE)
                .add("assets/a.png", image("opaque.png"))
                .build();

        assertRefused(read(asEncrypted(zip, 1)), "entry 2 is encrypted");
    }

    @Test
    void an_archive_inside_the_package_is_refused_by_its_name_and_by_its_bytes() {
        byte[] inner = zip().add("x.txt", "x").build();
        byte[] byName =
                zip().add("article.md", ARTICLE).add("assets/inner.zip", inner).build();
        byte[] byBytes = zip().add("article.md", ARTICLE)
                .add("assets/" + MARKER + ".png", inner)
                .build();
        byte[] gzipped = zip().add("article.md", ARTICLE)
                .add("assets/a.png", new byte[] {0x1F, (byte) 0x8B, 8, 0, 0, 0})
                .build();

        assertRefused(read(byName), "entry 2 is an archive");
        assertRefused(read(byBytes), "entry 2 is an archive");
        assertRefused(read(gzipped), "entry 2 is an archive");
    }

    @Test
    void a_decompression_bomb_is_refused_by_its_ratio_before_it_is_read_in_full() {
        byte[] zeros = new byte[3 * 1024 * 1024];
        byte[] zip = zip().add("article.md", ARTICLE).add("assets/a.png", zeros).build();

        assertThat(zip.length).isLessThan(zeros.length / PostFileLimits.MAX_PACKAGE_COMPRESSION_RATIO);
        assertRefused(read(zip), "entry 2 unpacks to far more than it should");
    }

    @Test
    void the_unpacked_size_of_all_entries_is_capped() {
        // Two symbols make 8:1 packing: each entry is under its own cap and its ratio, the sum is over 16 MiB.
        Random random = new Random(7);
        var builder = zip().add("article.md", ARTICLE);
        for (int i = 0; i < 5; i++) {
            byte[] data = new byte[3_500_000];
            for (int j = 0; j < data.length; j++) {
                data[j] = (byte) ('a' + random.nextInt(2));
            }
            builder.add("assets/" + i + ".png", data);
        }
        byte[] zip = builder.build();

        assertThat(zip.length).isLessThanOrEqualTo(PostFileLimits.MAX_PACKAGE_BYTES);
        assertRefused(read(zip), "larger than 16 MiB when unpacked");
    }

    @Test
    void the_unpacked_size_counts_against_what_earlier_packages_of_the_request_used() {
        byte[] zip = zip().add("article.md", ARTICLE)
                .add("assets/a.png", image("opaque.png"))
                .build();

        assertThat(PostPackageReader.read(zip, 100).problems().get(0)).contains("when unpacked");
        assertThat(PostPackageReader.read(zip, BUDGET).readable()).isTrue();
    }

    @Test
    void a_refused_package_reports_the_bytes_it_had_unpacked_until_the_refusal() {
        Random random = new Random(11);
        byte[] filler = new byte[300_000];
        for (int i = 0; i < filler.length; i++) {
            filler[i] = (byte) (random.nextInt(8) == 0 ? 'b' : 'a');
        }
        byte[] inner = zip().add("x.txt", "x").build();
        // The archive inside is only found by its bytes, after the entry was unpacked, and the entry before it was read
        // in full.
        byte[] late = zip().add("article.md", ARTICLE)
                .add("assets/a.png", filler)
                .add("assets/b.png", inner)
                .build();

        PostPackage pack = read(late);

        assertRefused(pack, "entry 3 is an archive");
        assertThat(pack.unpackedBytes()).isGreaterThanOrEqualTo(filler.length + inner.length);
        // Nothing was unpacked before an archive that is not one, and a refusal over the budget counts what was read.
        assertThat(read("just some text".getBytes(UTF_8)).unpackedBytes()).isZero();
        assertThat(PostPackageReader.read(late, 100).unpackedBytes()).isGreaterThan(100);
    }

    @Test
    void one_image_over_its_cap_is_refused() {
        Random random = new Random(3);
        byte[] big = new byte[PostFileLimits.MAX_PACKAGE_ASSET_BYTES + 1];
        for (int i = 0; i < big.length; i++) {
            big[i] = (byte) ('a' + random.nextInt(2));
        }
        byte[] zip = zip().add("article.md", ARTICLE).add("assets/a.png", big).build();

        assertRefused(read(zip), "entry 2 is larger than " + PostFileLimits.MAX_PACKAGE_ASSET_BYTES + " bytes");
    }

    @Test
    void an_article_over_its_cap_is_refused() {
        Random random = new Random(5);
        byte[] big = new byte[PostFile.MAX_BYTES + 1];
        for (int i = 0; i < big.length; i++) {
            big[i] = (byte) ('a' + random.nextInt(2));
        }
        byte[] zip = zip().add("article.md", big).build();

        assertRefused(read(zip), "the Markdown file (entry 1) is larger than " + PostFile.MAX_BYTES + " bytes");
    }

    @Test
    void the_caps_are_the_documented_ones_and_a_file_of_exactly_the_cap_is_read() {
        // docs: backend README (ZIP packages) and docs/SECURITY.md state these figures.
        assertThat(PostFileLimits.MAX_PACKAGE_BYTES).isEqualTo(4 * 1024 * 1024);
        assertThat(PostFileLimits.MAX_PACKAGE_ENTRIES).isEqualTo(40);
        assertThat(PostFile.MAX_BYTES).isEqualTo(256 * 1024);
        assertThat(PostFileLimits.MAX_PACKAGE_ASSET_BYTES).isEqualTo(4 * 1024 * 1024);
        assertThat(PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES).isEqualTo(16L * 1024 * 1024);
        assertThat(PostFileLimits.MAX_PACKAGE_COMPRESSION_RATIO).isEqualTo(100);

        Random random = new Random(11);
        byte[] article = new byte[PostFile.MAX_BYTES];
        for (int i = 0; i < article.length; i++) {
            article[i] = (byte) ('a' + random.nextInt(2));
        }
        byte[] asset = new byte[PostFileLimits.MAX_PACKAGE_ASSET_BYTES];
        for (int i = 0; i < asset.length; i++) {
            asset[i] = (byte) ('a' + random.nextInt(2));
        }
        byte[] zip = zip().add("article.md", article).add("assets/a.png", asset).build();

        assertThat(zip.length).isLessThanOrEqualTo(PostFileLimits.MAX_PACKAGE_BYTES);
        PostPackage pack = read(zip);
        assertThat(pack.readable()).isTrue();
        assertThat(pack.assets().get(0).data()).hasSize(PostFileLimits.MAX_PACKAGE_ASSET_BYTES);
        assertThat(pack.markdown()).hasSize(PostFile.MAX_BYTES);
    }

    @Test
    void a_package_over_its_cap_is_refused_before_it_is_opened() {
        byte[] zip = new byte[PostFileLimits.MAX_PACKAGE_BYTES + 1];
        zip[0] = 'P';
        zip[1] = 'K';
        zip[2] = 3;
        zip[3] = 4;

        assertRefused(read(zip), "larger than " + PostFileLimits.MAX_PACKAGE_BYTES + " bytes");
    }

    @Test
    void more_entries_than_the_cap_are_refused_before_any_is_read() {
        var builder = zip().add("article.md", ARTICLE);
        for (int i = 0; i < PostFileLimits.MAX_PACKAGE_ENTRIES; i++) {
            builder.add("assets/" + i + ".png", image("opaque.png"));
        }

        assertRefused(read(builder.build()), "more than " + PostFileLimits.MAX_PACKAGE_ENTRIES + " entries");
    }

    @Test
    void exactly_the_most_entries_is_accepted() {
        var builder = zip().add("article.md", ARTICLE);
        for (int i = 1; i < PostFileLimits.MAX_PACKAGE_ENTRIES; i++) {
            builder.add("assets/" + i + ".png", image("opaque.png"));
        }

        PostPackage pack = read(builder.build());

        assertThat(pack.readable()).isTrue();
        assertThat(pack.entries()).isEqualTo(PostFileLimits.MAX_PACKAGE_ENTRIES);
    }

    // --- Hostile archives -------------------------------------------------------------------------------------

    @Test
    void a_file_that_is_not_a_zip_is_refused() {
        assertRefused(read("just some text".getBytes(UTF_8)), "not a ZIP archive");
        assertRefused(read(new byte[0]), "empty");
        assertRefused(read(null), "empty");
    }

    @Test
    void a_truncated_archive_is_refused() {
        byte[] zip = zip().add("article.md", ARTICLE)
                .add("assets/a.png", image("opaque.png"))
                .build();

        assertRefused(read(Arrays.copyOf(zip, zip.length - 30)), "damaged or truncated");
        assertRefused(read(Arrays.copyOf(zip, 30)), "damaged or truncated");
        assertRefused(read(Arrays.copyOf(zip, 4)), "damaged or truncated");
    }

    @Test
    void entries_that_do_not_match_the_directory_are_refused() {
        byte[] zip = zip().add("article.md", ARTICLE)
                .add("assets/aaa.png", image("opaque.png"))
                .build();
        // Rename the first occurrence only: the local header says one name, the directory another.
        byte[] first = zip.clone();
        byte[] from = "assets/aaa.png".getBytes(UTF_8);
        byte[] to = "assets/bbb.png".getBytes(UTF_8);
        for (int i = 0; i + from.length <= first.length; i++) {
            if (Arrays.equals(Arrays.copyOfRange(first, i, i + from.length), from)) {
                System.arraycopy(to, 0, first, i, to.length);
                break;
            }
        }

        assertRefused(read(first), "do not match its directory");
    }

    @Test
    void a_package_of_folders_only_has_no_article() {
        assertRefused(read(zip().folder("assets").folder("more").build()), "no Markdown file");
    }

    @Test
    void a_package_needs_exactly_one_article_at_the_top_or_in_the_one_folder() {
        assertRefused(read(zip().add("assets/a.png", image("opaque.png")).build()), "no Markdown file");
        assertRefused(read(zip().add("a.md", ARTICLE).add("b.md", ARTICLE).build()), "more than one Markdown file");
        assertRefused(read(zip().add("one/two/a.md", ARTICLE).build()), "top level or in the one top-level folder");
    }

    @Test
    void an_article_that_is_not_utf8_text_is_refused_with_its_line_and_never_its_text() {
        byte[] zip = zip().add("article.md", "---\ntitle: One\n---\n\nFirst\nSecond " + MARKER + "\u0001 line\n")
                .build();

        PostPackage pack = read(zip);

        assertRefused(pack, "the Markdown file:", "line 6");
    }

    @Test
    void zip64_and_multi_part_archives_are_refused() {
        byte[] zip = zip().add("article.md", ARTICLE).build();
        int end = zip.length - 22;
        byte[] multi = zip.clone();
        multi[end + 8] = 5; // entries on this disk differ from the entries of the archive
        byte[] big = zip.clone();
        big[end + 10] = (byte) 0xFF; // the marker of an archive that needs ZIP64
        big[end + 11] = (byte) 0xFF;

        assertRefused(read(multi), "several parts");
        assertRefused(read(big), "ZIP64");
    }
}
