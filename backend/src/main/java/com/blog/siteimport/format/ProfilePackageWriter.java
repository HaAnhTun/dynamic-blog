package com.blog.siteimport.format;

import com.blog.common.util.SlugGenerator;
import com.blog.media.service.ImageFormat;
import com.blog.postimport.format.PostFileLimits;
import com.blog.postimport.format.PostPackageRefs;
import com.blog.postimport.format.PostPackageRefs.Ref;
import com.blog.postimport.format.PostPackageWriter;
import com.blog.sitecontent.schema.SiteContentKey;
import java.nio.charset.StandardCharsets;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Writes the site profile of one language as a ZIP package, the inverse of the package import: {@code profile.md} (the file of
 * {@link ProfileMarkdownWriter}) and, under {@code assets/}, every image the content uses that is a site image: the photo of
 * the About page, the images of its body and the logos of the timeline entries. A pure class: the images come through a
 * function, so nothing here reads a database.
 *
 * <p>The references are rewritten with the scanner the import uses, so a reference is rewritten if and only if the import
 * finds it again. An image the function does not know, that is not a JPEG, PNG or WebP image, that is larger than one asset may
 * be, or that would not fit the limits of a package keeps its {@code /media/} reference and goes nowhere in the package. The
 * bytes depend only on the values and the images (fixed order, time and compression), so two exports of the same content are
 * identical.
 */
public final class ProfilePackageWriter {

    /** The Markdown file of every package. */
    public static final String PROFILE = "profile.md";

    /** A site image as the content stores it: {@code /media/<uuid>.<jpg|png>}, optionally followed by the {@code #<w>x<h>} an import appends. */
    private static final Pattern MEDIA = Pattern.compile(
            "/media/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(?:jpg|png))(?:#[0-9]+x[0-9]+)?");

    private static final int MAX_BASE_CHARS = 40;

    /** Room kept for the profile file and the headers of the entries when the images are counted against the package size. */
    private static final int RESERVED_BYTES = ProfileFile.MAX_BYTES + 2 * 1024 * PostFileLimits.MAX_PACKAGE_ENTRIES;

    private ProfilePackageWriter() {}

    /**
     * @param payloads the stored content of the language by key, as {@link ProfileMarkdownWriter#write} takes it
     * @param images the image of a stored file name ({@code <uuid>.<ext>}), or null when there is none
     */
    public static byte[] write(
            String locale, Map<SiteContentKey, JsonNode> payloads, Function<String, PostPackageWriter.Image> images) {
        Packer packer = new Packer(images);
        Map<SiteContentKey, JsonNode> written = new EnumMap<>(SiteContentKey.class);
        written.putAll(payloads);
        if (payloads.get(SiteContentKey.ABOUT) instanceof ObjectNode about) {
            ObjectNode copy = about.deepCopy();
            packPhoto(copy, packer);
            packBody(copy, packer);
            written.put(SiteContentKey.ABOUT, copy);
        }
        if (payloads.get(SiteContentKey.TIMELINE) instanceof ObjectNode timeline) {
            ObjectNode copy = timeline.deepCopy();
            packLogos(copy, packer);
            written.put(SiteContentKey.TIMELINE, copy);
        }
        byte[] profile = ProfileMarkdownWriter.write(locale, written, false).getBytes(StandardCharsets.UTF_8);
        return PostPackageWriter.archive(PROFILE, profile, packer.files());
    }

    private static void packPhoto(ObjectNode about, Packer packer) {
        String path = packed(about.path("photo"), "photo", packer);
        if (path != null) {
            about.put("photo", path);
        }
    }

    private static void packBody(ObjectNode about, Packer packer) {
        if (!about.path("body").isString()) {
            return;
        }
        String body = about.get("body").asString();
        Map<Ref, String> replacements = new HashMap<>();
        for (Ref ref : PostPackageRefs.scan(body).refs()) {
            Matcher media = MEDIA.matcher(ref.raw());
            String path = media.matches() ? packer.pack(media.group(1), ref.alt()) : null;
            if (path != null) {
                replacements.put(ref, path);
            }
        }
        if (!replacements.isEmpty()) {
            about.put("body", PostPackageRefs.rewrite(body, replacements));
        }
    }

    private static void packLogos(ObjectNode timeline, Packer packer) {
        for (JsonNode entry : timeline.path("entries")) {
            if (entry instanceof ObjectNode object) {
                String path =
                        packed(object.path("logo"), "logo " + object.path("org").asString(""), packer);
                if (path != null) {
                    object.put("logo", path);
                }
            }
        }
    }

    /** The package path of the site image a text value names, or null when the value names none or it cannot be packed. */
    private static String packed(JsonNode value, String hint, Packer packer) {
        if (!value.isString()) {
            return null;
        }
        Matcher media = MEDIA.matcher(value.asString());
        return media.matches() ? packer.pack(media.group(1), hint) : null;
    }

    private record Packed(String path, byte[] data) {}

    /** The images placed in the package so far, in the order they were first needed. */
    private static final class Packer {

        private final Function<String, PostPackageWriter.Image> images;
        private final Map<String, Packed> packed = new LinkedHashMap<>();
        private final Set<String> left = new HashSet<>();
        private long assetBytes;

        Packer(Function<String, PostPackageWriter.Image> images) {
            this.images = images;
        }

        /** The path in the package of the stored image of this file name, or null when it stays a {@code /media/} reference. */
        String pack(String file, String hint) {
            Packed existing = packed.get(file);
            if (existing != null) {
                return existing.path();
            }
            if (left.contains(file)) {
                return null;
            }
            PostPackageWriter.Image image = images.apply(file);
            String extension = extensionOf(image);
            if (extension == null
                    || image.data().length > PostFileLimits.MAX_PACKAGE_ASSET_BYTES
                    || packed.size() + 2 > PostFileLimits.MAX_PACKAGE_ENTRIES
                    || assetBytes + image.data().length + RESERVED_BYTES > PostFileLimits.MAX_PACKAGE_BYTES) {
                left.add(file);
                return null;
            }
            Packed one = new Packed(
                    "assets/" + baseName(hint, image) + "-" + (packed.size() + 1) + "." + extension, image.data());
            packed.put(file, one);
            assetBytes += image.data().length;
            return one.path();
        }

        Map<String, byte[]> files() {
            Map<String, byte[]> files = new LinkedHashMap<>();
            packed.values().forEach(one -> files.put(one.path(), one.data()));
            return files;
        }
    }

    /** The extension of the real format of the image, null when there is no image or it is not one the import accepts. */
    private static String extensionOf(PostPackageWriter.Image image) {
        if (image == null || image.data() == null || image.data().length == 0) {
            return null;
        }
        return ImageFormat.sniff(image.data())
                .map(format -> switch (format) {
                    case JPEG -> "jpg";
                    case PNG -> "png";
                    case WEBP -> "webp";
                })
                .orElse(null);
    }

    /** ASCII, readable: what the content calls the image, else the description stored with it, else its file name. */
    private static String baseName(String hint, PostPackageWriter.Image image) {
        String base = slug(hint);
        if (base.isEmpty()) {
            base = slug(image.altText());
        }
        if (base.isEmpty()) {
            String name = image.originalFilename();
            int dot = name == null ? -1 : name.lastIndexOf('.');
            base = slug(dot > 0 ? name.substring(0, dot) : name);
        }
        return base.isEmpty() ? "image" : base;
    }

    private static String slug(String text) {
        if (text == null) {
            return "";
        }
        String slug = SlugGenerator.slugifyOrEmpty(text);
        if (slug.length() > MAX_BASE_CHARS) {
            slug = slug.substring(0, MAX_BASE_CHARS).replaceAll("-+$", "");
        }
        return slug;
    }
}
