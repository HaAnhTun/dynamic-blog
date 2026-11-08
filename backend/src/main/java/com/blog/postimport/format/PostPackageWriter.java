package com.blog.postimport.format;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.util.SlugGenerator;
import com.blog.media.service.ImageFormat;
import com.blog.postimport.format.PostPackageRefs.Ref;
import com.blog.postimport.format.PostPackageRefs.Scan;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.CRC32;
import java.util.zip.Deflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.springframework.http.HttpStatus;

/**
 * Writes a post as a ZIP package, the exact inverse of {@link PostPackageReader}: {@code article.md} (the post file of
 * {@link PostMarkdownWriter}, series keys included) and, under {@code assets/}, the images of the body that are site media.
 * A pure class: the images come through a function, so nothing here reads a database.
 *
 * <p>The body is rewritten with the same scanner the import uses ({@link PostPackageRefs#scan}), so a reference is rewritten
 * if and only if the import finds it again: a Markdown image or link, a link reference definition, the {@code src} of a
 * {@code figure} block. A {@code /media/<id>.<ext>} written in a code fence, in inline code or in raw HTML is left as written.
 * An image the function does not know, that is not a JPEG, PNG or WebP, that is larger than one asset may be, or that would
 * not fit the limits of a package keeps its original reference and goes nowhere in the package.
 *
 * <p>The bytes depend only on the values and the images: entries in a fixed order, a fixed time, a fixed compression level, so
 * two exports of the same post are identical.
 */
public final class PostPackageWriter {

    /** Fixed sentence of the refusal of a post that cannot fit a package. */
    public static final String TOO_LARGE = "The post is too large to export as a package";

    static final String ARTICLE = "article.md";

    /**
     * A body image as the site stores it: {@code /media/<uuid>.<jpg|png>}, optionally followed by the {@code #<w>x<h>} the
     * import appends. Anything else (another host, another path) is not a site image and is never touched.
     */
    private static final Pattern MEDIA = Pattern.compile(
            "/media/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(?:jpg|png))(?:#[0-9]+x[0-9]+)?");

    /** Chars of the readable part of an image file name. */
    private static final int MAX_BASE_CHARS = 40;

    /** Room kept for the article and the headers of the entries when the images are counted against the package size. */
    private static final int RESERVED_BYTES = PostFile.MAX_BYTES + 2 * 1024 * PostFileLimits.MAX_PACKAGE_ENTRIES;

    /** The article is stored instead of deflated when it would pack tighter than this, so the reader never takes it for a bomb. */
    private static final int SAFE_RATIO = PostFileLimits.MAX_PACKAGE_COMPRESSION_RATIO / 2;

    private static final LocalDateTime FIXED_TIME = LocalDateTime.of(2000, 1, 1, 0, 0);

    private PostPackageWriter() {}

    /** An image of the body: its bytes and what is known about it to name the file. */
    public record Image(byte[] data, String altText, String originalFilename) {}

    /**
     * @param values the post as {@link PostMarkdownWriter} takes it; its content is the body as stored
     * @param images the image of a stored file name ({@code <uuid>.<ext>}), or null when there is none
     * @return the bytes of the package
     * @throws ApiException 413 {@code POST_EXPORT_TOO_LARGE} when the article alone is larger than the import accepts or the
     *     package is larger than the import accepts even without images
     */
    public static byte[] write(PostFileValues values, Function<String, Image> images) {
        return write(values, images, null);
    }

    /**
     * Like {@link #write(PostFileValues, Function)}, with the cover of the post: its bytes go under {@code assets/} with an ASCII
     * name ({@code cover-1.png}, the real format of the image) and the article names it with {@code cover} and, when it has a
     * description, {@code cover_alt}. A cover that is null, not a JPEG, PNG or WebP image, larger than one asset may be, or
     * would not fit the limits of a package is left out of the package.
     */
    public static byte[] write(PostFileValues values, Function<String, Image> images, Image cover) {
        String content = values.content() == null ? "" : values.content();
        Scan scan = PostPackageRefs.scan(content);
        Map<String, Packed> packed = new LinkedHashMap<>();
        Set<String> left = new HashSet<>();
        Map<Ref, String> replacements = new HashMap<>();
        String coverExtension = extensionOf(cover);
        boolean withCover = coverExtension != null
                && cover.data().length <= PostFileLimits.MAX_PACKAGE_ASSET_BYTES
                && cover.data().length + RESERVED_BYTES <= PostFileLimits.MAX_PACKAGE_BYTES;
        // The cover takes one entry and its bytes before any body image does.
        int reserved = withCover ? 1 : 0;
        long assetBytes = withCover ? cover.data().length : 0;
        for (Ref ref : scan.refs()) {
            Matcher media = MEDIA.matcher(ref.raw());
            if (!media.matches()) {
                continue;
            }
            String file = media.group(1);
            Packed existing = packed.get(file);
            if (existing == null && !left.contains(file)) {
                Image image = images.apply(file);
                String extension = extensionOf(image);
                if (extension == null
                        || image.data().length > PostFileLimits.MAX_PACKAGE_ASSET_BYTES
                        || packed.size() + 2 + reserved > PostFileLimits.MAX_PACKAGE_ENTRIES
                        || assetBytes + image.data().length + RESERVED_BYTES > PostFileLimits.MAX_PACKAGE_BYTES) {
                    left.add(file);
                } else {
                    existing = new Packed(
                            "assets/" + baseName(ref, image) + "-" + (packed.size() + 1) + "." + extension,
                            image.data());
                    packed.put(file, existing);
                    assetBytes += image.data().length;
                }
            }
            if (existing != null) {
                replacements.put(ref, existing.path());
            }
        }
        Packed packedCover = withCover ? new Packed(coverPath(packed, coverExtension), cover.data()) : null;
        PostFileValues written = withContent(values, PostPackageRefs.rewrite(content, replacements));
        if (packedCover != null) {
            written = withCover(written, packedCover.path(), cover.altText());
        }
        byte[] article = PostMarkdownWriter.write(written).getBytes(StandardCharsets.UTF_8);
        if (article.length > PostFile.MAX_BYTES) {
            throw tooLarge();
        }
        byte[] zip = zip(article, packed, packedCover);
        if (zip.length > PostFileLimits.MAX_PACKAGE_BYTES) {
            throw tooLarge();
        }
        return zip;
    }

    private record Packed(String path, byte[] data) {}

    /** {@code assets/cover-<n>.<ext>}, with the first {@code n} that no image of the body already has. */
    private static String coverPath(Map<String, Packed> packed, String extension) {
        Set<String> taken = new HashSet<>();
        packed.values().forEach(image -> taken.add(image.path()));
        int number = 1;
        while (taken.contains("assets/cover-" + number + "." + extension)) {
            number++;
        }
        return "assets/cover-" + number + "." + extension;
    }

    private static PostFileValues withCover(PostFileValues v, String cover, String coverAlt) {
        return new PostFileValues(
                v.title(),
                v.slug(),
                v.language(),
                v.excerpt(),
                v.category(),
                v.tags(),
                v.featured(),
                v.status(),
                v.translationOf(),
                v.series(),
                v.seriesPart(),
                v.seriesDescription(),
                cover,
                coverAlt,
                v.content());
    }

    private static PostFileValues withContent(PostFileValues v, String content) {
        return new PostFileValues(
                v.title(),
                v.slug(),
                v.language(),
                v.excerpt(),
                v.category(),
                v.tags(),
                v.featured(),
                v.status(),
                v.translationOf(),
                v.series(),
                v.seriesPart(),
                v.seriesDescription(),
                v.cover(),
                v.coverAlt(),
                content);
    }

    private static ApiException tooLarge() {
        return new ApiException(ErrorCode.POST_EXPORT_TOO_LARGE, HttpStatus.CONTENT_TOO_LARGE, TOO_LARGE);
    }

    /** The extension of the real format of the image, null when there is no image or it is not one the import accepts. */
    private static String extensionOf(Image image) {
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

    /** ASCII, readable: the first description of the image in the body, else the description stored with it, else its file name. */
    private static String baseName(Ref ref, Image image) {
        String base = slug(ref.alt());
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

    // --- The archive ------------------------------------------------------------------------------------------

    private static byte[] zip(byte[] article, Map<String, Packed> packed, Packed cover) {
        Map<String, byte[]> files = new LinkedHashMap<>();
        packed.values().forEach(asset -> files.put(asset.path(), asset.data()));
        if (cover != null) {
            files.put(cover.path(), cover.data());
        }
        return archive(ARTICLE, article, files);
    }

    /**
     * The bytes of a package: the Markdown file under {@code markdownName}, then the files (images, already compressed, so
     * stored as they are) in the order of the map, all with the fixed time and compression level that make two exports of the
     * same values identical. Another package writer (the site profile) builds on this one so that both read back the same way.
     */
    public static byte[] archive(String markdownName, byte[] markdown, Map<String, byte[]> files) {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (ZipOutputStream out = new ZipOutputStream(bytes, StandardCharsets.UTF_8)) {
            out.setLevel(Deflater.DEFAULT_COMPRESSION);
            put(
                    out,
                    markdownName,
                    markdown,
                    markdown.length <= PostFileLimits.MIN_BYTES_FOR_RATIO_CHECK || packsSafely(markdown));
            for (Map.Entry<String, byte[]> file : files.entrySet()) {
                // An image is already compressed: storing it costs nothing and cannot look like a bomb.
                put(out, file.getKey(), file.getValue(), false);
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return bytes.toByteArray();
    }

    private static void put(ZipOutputStream out, String name, byte[] data, boolean deflate) throws IOException {
        ZipEntry entry = new ZipEntry(name);
        entry.setTimeLocal(FIXED_TIME);
        if (!deflate) {
            CRC32 crc = new CRC32();
            crc.update(data);
            entry.setMethod(ZipEntry.STORED);
            entry.setSize(data.length);
            entry.setCompressedSize(data.length);
            entry.setCrc(crc.getValue());
        }
        out.putNextEntry(entry);
        out.write(data);
        out.closeEntry();
    }

    /** Whether deflating keeps the entry far enough from the ratio the reader treats as a decompression bomb. */
    private static boolean packsSafely(byte[] data) {
        Deflater deflater = new Deflater();
        try {
            deflater.setInput(data);
            deflater.finish();
            byte[] chunk = new byte[8192];
            long compressed = 0;
            while (!deflater.finished()) {
                compressed += deflater.deflate(chunk);
            }
            return data.length <= (long) SAFE_RATIO * Math.max(compressed, 1);
        } finally {
            deflater.end();
        }
    }
}
