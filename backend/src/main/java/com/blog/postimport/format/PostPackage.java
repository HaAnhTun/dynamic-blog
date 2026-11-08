package com.blog.postimport.format;

import com.blog.media.service.ImageFormat;
import java.util.List;

/**
 * What {@link PostPackageReader} makes of one ZIP package: the article file (decoded like a plain post file), the images next
 * to it and the problems of the archive itself. A package the reader refused has no article ({@link #readable()} is false) and
 * exactly one problem. Every message names an entry by its 1-based position in the archive and never holds a name or any text
 * from the archive.
 *
 * @param markdown the decoded article file ({@link PostFile#decode}), null when the package was refused
 * @param assets the images under {@code assets/}, in archive order
 * @param entries how many entries (files and folders) the archive has
 * @param unpackedBytes the bytes of all entries once unpacked, counted while reading (also for a refused package: what it had
 *     unpacked until the refusal)
 * @param problems blocking problems: why the package was refused, or, for a readable package, the entries that cannot be used
 *     (an image in a format other than JPEG, PNG or WebP, a file outside {@code assets/})
 * @param unsupportedItems how many entries are such entries that cannot be used
 */
public record PostPackage(
        String markdown,
        List<Asset> assets,
        int entries,
        long unpackedBytes,
        List<String> problems,
        int unsupportedItems) {

    /**
     * One image of a package.
     *
     * @param entry 1-based position of the entry in the archive
     * @param path the path relative to the article file, with {@code /} (for example {@code assets/figure-1.png}), NFC
     * @param data the bytes as stored in the archive
     * @param format the format by magic bytes; null when it is not JPEG, PNG or WebP
     */
    public record Asset(int entry, String path, byte[] data, ImageFormat format) {}

    public PostPackage {
        assets = assets == null ? List.of() : List.copyOf(assets);
        problems = problems == null ? List.of() : List.copyOf(problems);
    }

    /**
     * A package that could not be read at all: no article, no assets and the one reason. The bytes the reader had unpacked when
     * it refused count against the request's unpack budget like the bytes of a package that was read.
     */
    public static PostPackage refused(String problem, long unpackedBytes) {
        return new PostPackage(null, List.of(), 0, unpackedBytes, List.of(problem), 0);
    }

    public boolean readable() {
        return markdown != null;
    }

    public long assetBytes() {
        long total = 0;
        for (Asset asset : assets) {
            total += asset.data().length;
        }
        return total;
    }
}
