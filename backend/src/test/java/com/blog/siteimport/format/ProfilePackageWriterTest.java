package com.blog.siteimport.format;

import static org.assertj.core.api.Assertions.assertThat;

import com.blog.postimport.format.PostFileLimits;
import com.blog.postimport.format.PostPackage;
import com.blog.postimport.format.PostPackageReader;
import com.blog.postimport.format.PostPackageWriter;
import com.blog.sitecontent.schema.SiteContentKey;
import com.blog.support.ZipPackages;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Function;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The ZIP package of a site profile: the profile file and the site images the content uses, written so that the package reader
 * and the profile parser take back exactly what the content said.
 */
class ProfilePackageWriterTest {

    private static final String PHOTO = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.png";
    private static final String VIEW = "1b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.png";
    private static final String LOGO = "2b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.jpg";
    private static final String GONE = "3b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.png";

    private static final byte[] PNG_PHOTO = ZipPackages.image("opaque.png");
    private static final byte[] PNG_VIEW = ZipPackages.image("p3.png");
    private static final byte[] JPEG_LOGO = ZipPackages.image("cmyk.jpg");

    private final Map<String, PostPackageWriter.Image> stored = new HashMap<>(Map.of(
            PHOTO, new PostPackageWriter.Image(PNG_PHOTO, null, "me.png"),
            VIEW, new PostPackageWriter.Image(PNG_VIEW, "A view of the bay", "view.png"),
            LOGO, new PostPackageWriter.Image(JPEG_LOGO, null, "company.jpg")));

    private final Function<String, PostPackageWriter.Image> images = stored::get;

    private static Map<SiteContentKey, JsonNode> content() {
        Map<SiteContentKey, JsonNode> payloads = ProfileRoundTrip.packagedDefaults("en");
        ObjectNode about = ProfileRoundTrip.copy(payloads.get(SiteContentKey.ABOUT));
        about.put("photo", "/media/" + PHOTO);
        about.put(
                "body",
                "Opening text.\n\n![The bay](/media/" + VIEW + "#40x30)\n\nSee [the same view](/media/" + VIEW
                        + "#40x30) and ![gone](/media/" + GONE + "#10x10).");
        payloads.put(SiteContentKey.ABOUT, ProfileRoundTrip.normalized(SiteContentKey.ABOUT, about));
        ObjectNode timeline = ProfileRoundTrip.copy(payloads.get(SiteContentKey.TIMELINE));
        ((ObjectNode) timeline.get("entries").get(1)).put("org", "Example Corp").put("logo", "/media/" + LOGO);
        payloads.put(SiteContentKey.TIMELINE, ProfileRoundTrip.normalized(SiteContentKey.TIMELINE, timeline));
        return payloads;
    }

    @Test
    void the_photo_the_body_images_and_the_logos_are_packed_under_assets_with_readable_names() {
        byte[] zip = ProfilePackageWriter.write("en", content(), images);

        PostPackage pack = PostPackageReader.read(zip, PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);

        assertThat(pack.readable()).isTrue();
        assertThat(pack.problems()).isEmpty();
        assertThat(pack.assets())
                .extracting(PostPackage.Asset::path)
                .containsExactly("assets/photo-1.png", "assets/the-bay-2.png", "assets/logo-example-corp-3.jpg");
        assertThat(pack.assets().get(0).data()).isEqualTo(PNG_PHOTO);
        assertThat(pack.assets().get(1).data()).isEqualTo(PNG_VIEW);
        assertThat(pack.assets().get(2).data()).isEqualTo(JPEG_LOGO);
        assertThat(pack.markdown())
                .contains("- photo: assets/photo-1.png")
                .contains("![The bay](assets/the-bay-2.png)")
                .contains("[the same view](assets/the-bay-2.png)")
                .contains("- logo: assets/logo-example-corp-3.jpg")
                .doesNotContain("/media/" + PHOTO)
                .doesNotContain("/media/" + VIEW)
                .doesNotContain("/media/" + LOGO);
    }

    @Test
    void an_image_that_is_gone_keeps_its_media_reference() {
        byte[] zip = ProfilePackageWriter.write("en", content(), images);

        PostPackage pack = PostPackageReader.read(zip, PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);

        assertThat(pack.markdown()).contains("![gone](/media/" + GONE + "#10x10)");
        assertThat(pack.assets()).hasSize(3);
    }

    @Test
    void bytes_that_are_not_an_accepted_image_stay_a_media_reference() {
        stored.put(PHOTO, new PostPackageWriter.Image("<svg></svg>".getBytes(StandardCharsets.UTF_8), null, "me.svg"));

        PostPackage pack = PostPackageReader.read(
                ProfilePackageWriter.write("en", content(), images), PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);

        assertThat(pack.markdown()).contains("- photo: /media/" + PHOTO);
        assertThat(pack.assets()).hasSize(2);
    }

    @Test
    void one_image_used_twice_is_in_the_package_once() {
        Map<SiteContentKey, JsonNode> payloads = content();
        ObjectNode timeline = ProfileRoundTrip.copy(payloads.get(SiteContentKey.TIMELINE));
        ((ObjectNode) timeline.get("entries").get(0)).put("logo", "/media/" + PHOTO);
        payloads.put(SiteContentKey.TIMELINE, ProfileRoundTrip.normalized(SiteContentKey.TIMELINE, timeline));

        PostPackage pack = PostPackageReader.read(
                ProfilePackageWriter.write("en", payloads, images), PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);

        assertThat(pack.assets()).hasSize(3);
        assertThat(pack.markdown().split("assets/photo-1.png", -1).length - 1).isEqualTo(2);
    }

    @Test
    void the_package_reads_back_as_the_content_it_was_written_from() {
        byte[] zip = ProfilePackageWriter.write("en", content(), images);
        PostPackage pack = PostPackageReader.read(zip, PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);

        ParsedProfile parsed =
                ProfileMarkdownParser.parse(ProfileFile.decode(pack.markdown().getBytes(StandardCharsets.UTF_8)));

        assertThat(parsed.problems()).isEmpty();
        assertThat(parsed.ignored()).isEmpty();
        assertThat(parsed.sections()).hasSize(SectionRegistry.sections().size());
    }

    @Test
    void two_exports_of_the_same_content_are_the_same_bytes() {
        assertThat(ProfilePackageWriter.write("en", content(), images))
                .isEqualTo(ProfilePackageWriter.write("en", content(), images));
    }

    @Test
    void content_without_images_is_a_package_with_the_profile_file_only() {
        byte[] zip = ProfilePackageWriter.write("en", ProfileRoundTrip.packagedDefaults("en"), images);

        PostPackage pack = PostPackageReader.read(zip, PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);

        assertThat(pack.readable()).isTrue();
        assertThat(pack.assets()).isEmpty();
        assertThat(pack.entries()).isEqualTo(1);
        assertThat(pack.markdown())
                .isEqualTo(ProfileMarkdownWriter.write("en", ProfileRoundTrip.packagedDefaults("en"), false));
    }

    @Test
    void images_past_the_entry_limit_of_a_package_stay_media_references() {
        Map<SiteContentKey, JsonNode> payloads = content();
        StringBuilder body = new StringBuilder("Many images.\n\n");
        for (int i = 0; i < PostFileLimits.MAX_PACKAGE_ENTRIES + 2; i++) {
            String file = String.format("%08x-4f50-4a6b-8c7d-9e0f1a2b3c4d.png", 0x10000000 + i);
            stored.put(file, new PostPackageWriter.Image(PNG_VIEW, null, "n" + i + ".png"));
            body.append("![](/media/").append(file).append(")\n\n");
        }
        ObjectNode about = ProfileRoundTrip.copy(payloads.get(SiteContentKey.ABOUT));
        about.put("body", body.toString().strip());
        payloads.put(SiteContentKey.ABOUT, ProfileRoundTrip.normalized(SiteContentKey.ABOUT, about));

        PostPackage pack = PostPackageReader.read(
                ProfilePackageWriter.write("en", payloads, images), PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);

        assertThat(pack.readable()).isTrue();
        assertThat(pack.entries()).isLessThanOrEqualTo(PostFileLimits.MAX_PACKAGE_ENTRIES);
        assertThat(pack.markdown()).contains("![](/media/");
    }
}
