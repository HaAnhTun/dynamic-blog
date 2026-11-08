package com.blog.postimport.format;

import com.blog.common.exception.ApiException;
import com.blog.media.service.ImageFormat;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Reads the bytes of an uploaded ZIP package into a {@link PostPackage} with {@code java.util.zip} only. The archive is
 * untrusted, so nothing is taken from it on its word:
 *
 * <ul>
 *   <li>The central directory is read first, by hand, from the byte array with bounds checks: it is the only place that holds
 *       the flags (encryption), the file mode (a symbolic link) and the real list of entries. The entries are then streamed
 *       with {@link ZipInputStream}, and each one must be an entry of that directory, once.
 *   <li>The sizes the archive declares are used only to refuse early. What counts is what is read: every entry is read in
 *       chunks and counted, against a cap per entry, a cap for the whole package and a compression ratio, and the read stops at
 *       the first byte over a cap.
 *   <li>Names are checked before anything is read (absolute paths, {@code ..}, backslashes, drive letters, control characters,
 *       invalid UTF-8, duplicates also after Unicode normalization (NFC) and case folding). Names are never used as file
 *       names: nothing here touches the file system.
 *   <li>Encrypted entries, links and other special files, nested archives and ZIP64 are refused. An image is accepted by its
 *       magic bytes, never by its name (JPEG, PNG and WebP; SVG is named in its own message).
 * </ul>
 *
 * <p>A package is one article file ({@code .md}, at the top or in the one top-level folder) and its images under
 * {@code assets/}. Folders and the noise of file managers ({@code __MACOSX}, {@code .DS_Store}) are skipped; any other entry is
 * a problem. A message names an entry by its position and never holds a name or any text of the archive, so a refusal can be
 * shown and logged. A pure class: no Spring context and no state.
 */
public final class PostPackageReader {

    static final String NOT_ZIP = "the file is not a ZIP archive";
    static final String DAMAGED = "the archive could not be read; it may be damaged or truncated";
    static final String ASSETS_DIRECTORY = "assets/";

    private static final int END_OF_CENTRAL_DIRECTORY = 0x06054b50;
    private static final int CENTRAL_ENTRY = 0x02014b50;
    private static final int END_RECORD_BYTES = 22;
    private static final int CENTRAL_ENTRY_BYTES = 46;
    private static final int MAX_COMMENT_BYTES = 0xFFFF;
    private static final long ZIP64_MARKER = 0xFFFFFFFFL;
    private static final int HEAD_BYTES = 16;
    private static final int SNIFF_SVG_BYTES = 2048;
    private static final int UNIX = 3;
    private static final int MODE_TYPE_MASK = 0xF000;
    private static final int MODE_REGULAR = 0x8000;
    private static final int MODE_DIRECTORY = 0x4000;
    private static final String SUPPORTED = "use JPEG, PNG or WebP";

    private PostPackageReader() {}

    /**
     * Never throws for a bad package: the reason is the one problem of the answer, and the bytes it had unpacked until then are
     * the answer's {@link PostPackage#unpackedBytes()}, so that a refused package is charged like a read one.
     *
     * @param zip the bytes as uploaded
     * @param budget how many unpacked bytes this package may add to the ones of the other packages of the same request
     */
    public static PostPackage read(byte[] zip, long budget) {
        Run run = new Run(zip, Math.min(budget, PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES));
        try {
            return run.read();
        } catch (Refusal refusal) {
            return PostPackage.refused(refusal.getMessage(), run.total);
        } catch (IOException | IllegalArgumentException | IndexOutOfBoundsException e) {
            // The library's message may hold a name from the archive: say only that it cannot be read.
            return PostPackage.refused(DAMAGED, run.total);
        }
    }

    /** The reason a package is refused. No stack trace: it is control flow, and its message is a fixed sentence. */
    private static final class Refusal extends RuntimeException {

        private static final long serialVersionUID = 1L;

        Refusal(String message) {
            super(message, null, false, false);
        }
    }

    private enum Kind {
        DIRECTORY,
        NOISE,
        ARTICLE,
        ASSET,
        OTHER
    }

    /** One record of the central directory. {@code position} is 1-based, in directory order. */
    private record Central(int position, String name, int method, long compressed, boolean directory) {}

    /** One entry read from the archive: the bytes kept (articles and images only) and the first bytes of any entry. */
    private record Unpacked(byte[] data, byte[] head) {}

    private static final class Run {

        private final byte[] zip;
        private final ByteBuffer bytes;
        private final long budget;
        private long total;

        Run(byte[] zip, long budget) {
            this.zip = zip == null ? new byte[0] : zip;
            this.bytes = ByteBuffer.wrap(this.zip).order(ByteOrder.LITTLE_ENDIAN);
            this.budget = budget;
        }

        PostPackage read() throws IOException {
            if (zip.length == 0) {
                throw new Refusal("the package is empty");
            }
            if (zip.length > PostFileLimits.MAX_PACKAGE_BYTES) {
                throw new Refusal("the package is larger than " + PostFileLimits.MAX_PACKAGE_BYTES + " bytes");
            }
            if (!startsWithLocalHeader()) {
                throw new Refusal(NOT_ZIP);
            }
            List<Central> central = centralDirectory();
            checkNames(central);
            int article = findArticle(central);
            String base = baseOf(central.get(article).name());
            Map<String, Central> byName = new HashMap<>();
            for (Central entry : central) {
                byName.put(entry.name(), entry);
            }
            return unpack(central, byName, article, base);
        }

        private boolean startsWithLocalHeader() {
            return zip.length >= 4 && zip[0] == 'P' && zip[1] == 'K' && zip[2] == 3 && zip[3] == 4
                    || zip.length >= 4 && zip[0] == 'P' && zip[1] == 'K' && zip[2] == 5 && zip[3] == 6;
        }

        // --- The central directory -----------------------------------------------------------------------

        private List<Central> centralDirectory() {
            int end = findEndRecord();
            int disk = bytes.getShort(end + 4) & 0xFFFF;
            int directoryDisk = bytes.getShort(end + 6) & 0xFFFF;
            int onThisDisk = bytes.getShort(end + 8) & 0xFFFF;
            int count = bytes.getShort(end + 10) & 0xFFFF;
            long size = bytes.getInt(end + 12) & 0xFFFFFFFFL;
            long offset = bytes.getInt(end + 16) & 0xFFFFFFFFL;
            if (count == 0xFFFF || size == ZIP64_MARKER || offset == ZIP64_MARKER) {
                throw new Refusal("ZIP64 archives are not supported; make a smaller package");
            }
            if (disk != 0 || directoryDisk != 0 || onThisDisk != count) {
                throw new Refusal("archives in several parts are not supported");
            }
            if (count == 0) {
                throw new Refusal("the package has no entries");
            }
            if (count > PostFileLimits.MAX_PACKAGE_ENTRIES) {
                throw new Refusal("the package has more than " + PostFileLimits.MAX_PACKAGE_ENTRIES + " entries");
            }
            if (offset + size > end) {
                throw new Refusal(DAMAGED);
            }
            List<Central> entries = new ArrayList<>(count);
            int at = (int) offset;
            long declaredCompressed = 0;
            for (int i = 0; i < count; i++) {
                if (at + CENTRAL_ENTRY_BYTES > end || bytes.getInt(at) != CENTRAL_ENTRY) {
                    throw new Refusal(DAMAGED);
                }
                int position = i + 1;
                int madeBy = bytes.getShort(at + 4) & 0xFFFF;
                int flags = bytes.getShort(at + 8) & 0xFFFF;
                int method = bytes.getShort(at + 10) & 0xFFFF;
                long compressed = bytes.getInt(at + 20) & 0xFFFFFFFFL;
                long uncompressed = bytes.getInt(at + 24) & 0xFFFFFFFFL;
                int nameLength = bytes.getShort(at + 28) & 0xFFFF;
                int extraLength = bytes.getShort(at + 30) & 0xFFFF;
                int commentLength = bytes.getShort(at + 32) & 0xFFFF;
                long external = bytes.getInt(at + 38) & 0xFFFFFFFFL;
                int nameAt = at + CENTRAL_ENTRY_BYTES;
                long next = (long) nameAt + nameLength + extraLength + commentLength;
                if (next > end) {
                    throw new Refusal(DAMAGED);
                }
                if (compressed == ZIP64_MARKER || uncompressed == ZIP64_MARKER) {
                    throw new Refusal("ZIP64 archives are not supported; make a smaller package");
                }
                // Encrypted (bit 0), strongly encrypted (bit 6) or with a masked directory (bit 13).
                if ((flags & (0x0001 | 0x0040 | 0x2000)) != 0) {
                    throw new Refusal("entry " + position + " is encrypted; a package cannot be password protected");
                }
                if (method != 0 && method != 8) {
                    throw new Refusal("entry " + position + " uses a compression method that is not supported");
                }
                if ((madeBy >>> 8) == UNIX) {
                    int type = (int) ((external >>> 16) & MODE_TYPE_MASK);
                    if (type != 0 && type != MODE_REGULAR && type != MODE_DIRECTORY) {
                        throw new Refusal(
                                "entry " + position + " is a link or a special file; only plain files are allowed");
                    }
                }
                String name = decodeName(position, nameAt, nameLength);
                boolean directory = name.endsWith("/");
                if (directory && uncompressed != 0) {
                    throw new Refusal(DAMAGED);
                }
                declaredCompressed += compressed;
                entries.add(new Central(position, name, method, compressed, directory));
                at = (int) next;
            }
            if (declaredCompressed > zip.length) {
                // The entries cannot hold more bytes than the archive has: the directory lies.
                throw new Refusal(DAMAGED);
            }
            return entries;
        }

        /** The last end-of-directory record, searched backwards through the longest comment a record can have. */
        private int findEndRecord() {
            int from = zip.length - END_RECORD_BYTES;
            if (from < 0) {
                throw new Refusal(DAMAGED);
            }
            int lowest = Math.max(0, from - MAX_COMMENT_BYTES);
            for (int at = from; at >= lowest; at--) {
                if (bytes.getInt(at) == END_OF_CENTRAL_DIRECTORY) {
                    int comment = bytes.getShort(at + 20) & 0xFFFF;
                    if (at + END_RECORD_BYTES + comment <= zip.length) {
                        return at;
                    }
                }
            }
            throw new Refusal(DAMAGED);
        }

        private String decodeName(int position, int at, int length) {
            try {
                return StandardCharsets.UTF_8
                        .newDecoder()
                        .onMalformedInput(CodingErrorAction.REPORT)
                        .onUnmappableCharacter(CodingErrorAction.REPORT)
                        .decode(ByteBuffer.wrap(zip, at, length))
                        .toString();
            } catch (CharacterCodingException e) {
                throw new Refusal("entry " + position + " has a name that is not valid UTF-8");
            }
        }

        // --- Names ----------------------------------------------------------------------------------------

        private static void checkNames(List<Central> central) {
            Map<String, Integer> folded = new HashMap<>();
            for (Central entry : central) {
                String reason = unsafeName(entry.name());
                if (reason != null) {
                    throw new Refusal("entry " + entry.position() + " has an unsafe name: " + reason);
                }
                String key = fold(
                        entry.name().endsWith("/")
                                ? entry.name().substring(0, entry.name().length() - 1)
                                : entry.name());
                Integer first = folded.putIfAbsent(key, entry.position());
                if (first != null) {
                    throw new Refusal("entries " + first + " and " + entry.position()
                            + " have the same name once Unicode form and letter case are ignored");
                }
            }
        }

        /** Why a name is not allowed, or null. The reasons are fixed sentences. */
        private static String unsafeName(String name) {
            String path = name.endsWith("/") ? name.substring(0, name.length() - 1) : name;
            if (path.isEmpty() || path.length() > PostFileLimits.MAX_PACKAGE_NAME_CHARS) {
                return "it is empty or too long";
            }
            for (int i = 0; i < path.length(); i++) {
                char c = path.charAt(i);
                if (c == 0 || Character.isISOControl(c)) {
                    return "it has a control character";
                }
                if (c == '\\') {
                    return "it has a backslash";
                }
            }
            if (path.charAt(0) == '/') {
                return "it is an absolute path";
            }
            if (path.length() >= 2 && Character.isLetter(path.charAt(0)) && path.charAt(1) == ':') {
                return "it starts with a drive letter";
            }
            int start = 0;
            while (start <= path.length()) {
                int slash = path.indexOf('/', start);
                int end = slash < 0 ? path.length() : slash;
                String segment = path.substring(start, end);
                if (segment.isEmpty()) {
                    return "it has an empty folder name";
                }
                if (segment.equals("..") || segment.equals(".")) {
                    return "it has a . or .. segment";
                }
                start = end + 1;
            }
            return null;
        }

        private static String fold(String name) {
            return Normalizer.normalize(name, Normalizer.Form.NFC)
                    .toUpperCase(Locale.ROOT)
                    .toLowerCase(Locale.ROOT);
        }

        private static boolean noise(String name) {
            String path = name.endsWith("/") ? name.substring(0, name.length() - 1) : name;
            for (String segment : path.split("/")) {
                if (segment.equals("__MACOSX")) {
                    return true;
                }
            }
            String base = path.substring(path.lastIndexOf('/') + 1);
            return base.equals(".DS_Store") || base.equals("Thumbs.db") || base.startsWith("._");
        }

        // --- The layout: one article, and the images next to it -----------------------------------------

        private static int findArticle(List<Central> central) {
            int found = -1;
            int count = 0;
            for (int i = 0; i < central.size(); i++) {
                Central entry = central.get(i);
                if (entry.directory() || noise(entry.name())) {
                    continue;
                }
                if (entry.name().toLowerCase(Locale.ROOT).endsWith(".md")) {
                    count++;
                    found = i;
                }
            }
            if (count == 0) {
                throw new Refusal("the package has no Markdown file (.md)");
            }
            if (count > 1) {
                throw new Refusal("the package has more than one Markdown file; a package is one article");
            }
            return found;
        }

        /** "" when the article is at the top, else its folder with the closing slash. */
        private static String baseOf(String articleName) {
            int slash = articleName.indexOf('/');
            if (slash < 0) {
                return "";
            }
            if (articleName.indexOf('/', slash + 1) >= 0) {
                throw new Refusal("the Markdown file must be at the top level or in the one top-level folder");
            }
            return articleName.substring(0, slash + 1);
        }

        private static Kind kindOf(Central entry, int index, int article, String base) {
            if (entry.directory()) {
                return Kind.DIRECTORY;
            }
            if (noise(entry.name())) {
                return Kind.NOISE;
            }
            if (index == article) {
                return Kind.ARTICLE;
            }
            String prefix = base + ASSETS_DIRECTORY;
            return entry.name().startsWith(prefix) && entry.name().length() > prefix.length() ? Kind.ASSET : Kind.OTHER;
        }

        // --- Unpacking -----------------------------------------------------------------------------------

        private PostPackage unpack(List<Central> central, Map<String, Central> byName, int article, String base)
                throws IOException {
            Map<Integer, Kind> kinds = new HashMap<>();
            for (int i = 0; i < central.size(); i++) {
                kinds.put(central.get(i).position(), kindOf(central.get(i), i, article, base));
            }
            String markdown = null;
            List<PostPackage.Asset> assets = new ArrayList<>();
            List<String> problems = new ArrayList<>();
            int unsupported = 0;
            int seen = 0;
            boolean[] visited = new boolean[central.size() + 1];
            try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zip), StandardCharsets.UTF_8)) {
                ZipEntry next;
                while ((next = in.getNextEntry()) != null) {
                    Central entry = byName.get(next.getName());
                    if (entry == null || visited[entry.position()]) {
                        throw new Refusal("the entries of the archive do not match its directory");
                    }
                    visited[entry.position()] = true;
                    seen++;
                    Kind kind = kinds.get(entry.position());
                    Unpacked unpacked = readEntry(in, entry, kind);
                    if (kind == Kind.DIRECTORY) {
                        continue;
                    }
                    if (looksLikeArchive(unpacked.head(), entry.name())) {
                        throw new Refusal("entry " + entry.position()
                                + " is an archive; archives inside a package are not allowed");
                    }
                    switch (kind) {
                        case ARTICLE -> markdown = decodeArticle(unpacked.data());
                        case ASSET -> {
                            ImageFormat format =
                                    ImageFormat.sniff(unpacked.data()).orElse(null);
                            if (format == null) {
                                unsupported++;
                                problems.add(unsupportedImage(entry.position(), unpacked.data()));
                            }
                            assets.add(new PostPackage.Asset(
                                    entry.position(),
                                    Normalizer.normalize(entry.name().substring(base.length()), Normalizer.Form.NFC),
                                    unpacked.data(),
                                    format));
                        }
                        case OTHER -> {
                            unsupported++;
                            problems.add("entry " + entry.position()
                                    + " is not the article and is not under assets/; remove it from the package");
                        }
                        default -> {
                            // Noise of a file manager: read (and counted) above, then ignored.
                        }
                    }
                }
            }
            if (seen != central.size()) {
                throw new Refusal(DAMAGED);
            }
            return new PostPackage(markdown, assets, central.size(), total, problems, unsupported);
        }

        private Unpacked readEntry(ZipInputStream in, Central entry, Kind kind) throws IOException {
            boolean keep = kind == Kind.ARTICLE || kind == Kind.ASSET;
            long limit = switch (kind) {
                case DIRECTORY -> 0;
                case ARTICLE -> PostFile.MAX_BYTES;
                default -> PostFileLimits.MAX_PACKAGE_ASSET_BYTES;
            };
            ByteArrayOutputStream out = keep ? new ByteArrayOutputStream() : null;
            byte[] head = new byte[HEAD_BYTES];
            int headLength = 0;
            byte[] chunk = new byte[8192];
            long size = 0;
            int read;
            while ((read = in.read(chunk)) > 0) {
                size += read;
                total += read;
                if (size > limit) {
                    throw new Refusal(
                            kind == Kind.ARTICLE
                                    ? "the Markdown file (entry " + entry.position() + ") is larger than " + limit
                                            + " bytes"
                                    : "entry " + entry.position() + " is larger than " + limit + " bytes");
                }
                if (total > budget) {
                    throw new Refusal("the package is larger than " + (budget >> 20)
                            + " MiB when unpacked, which is more than this import may hold");
                }
                if (size > PostFileLimits.MIN_BYTES_FOR_RATIO_CHECK
                        && size
                                > (long) PostFileLimits.MAX_PACKAGE_COMPRESSION_RATIO
                                        * Math.max(entry.compressed(), 1)) {
                    throw new Refusal(bomb(entry.position()));
                }
                if (total > PostFileLimits.MIN_BYTES_FOR_RATIO_CHECK
                        && total > (long) PostFileLimits.MAX_PACKAGE_COMPRESSION_RATIO * zip.length) {
                    throw new Refusal(bomb(entry.position()));
                }
                if (headLength < HEAD_BYTES) {
                    int copy = Math.min(HEAD_BYTES - headLength, read);
                    System.arraycopy(chunk, 0, head, headLength, copy);
                    headLength += copy;
                }
                if (out != null) {
                    out.write(chunk, 0, read);
                }
            }
            return new Unpacked(
                    out == null ? null : out.toByteArray(),
                    headLength == HEAD_BYTES ? head : java.util.Arrays.copyOf(head, headLength));
        }

        private static String bomb(int position) {
            return "entry " + position + " unpacks to far more than it should (more than "
                    + PostFileLimits.MAX_PACKAGE_COMPRESSION_RATIO + " times its packed size)";
        }

        private static String decodeArticle(byte[] data) {
            try {
                return PostFile.decode(data);
            } catch (ApiException e) {
                // The decoder's messages hold sizes and line numbers only.
                throw new Refusal("the Markdown file: " + e.getMessage());
            }
        }

        private static String unsupportedImage(int position, byte[] data) {
            String start = new String(data, 0, Math.min(data.length, SNIFF_SVG_BYTES), StandardCharsets.ISO_8859_1)
                    .toLowerCase(Locale.ROOT);
            if (start.contains("<svg")) {
                return "entry " + position + " is an SVG image, which is not supported because it can carry scripts; "
                        + "export it as PNG, JPEG or WebP";
            }
            return "entry " + position + " is not a JPEG, PNG or WebP image; " + SUPPORTED;
        }

        private static boolean looksLikeArchive(byte[] head, String name) {
            String lower = name.toLowerCase(Locale.ROOT);
            for (String extension :
                    List.of(".zip", ".jar", ".war", ".gz", ".tgz", ".tar", ".7z", ".rar", ".bz2", ".xz")) {
                if (lower.endsWith(extension)) {
                    return true;
                }
            }
            return startsWith(head, 'P', 'K', 3, 4)
                    || startsWith(head, 'P', 'K', 5, 6)
                    || startsWith(head, 0x1F, 0x8B)
                    || startsWith(head, '7', 'z', 0xBC, 0xAF, 0x27, 0x1C)
                    || startsWith(head, 'R', 'a', 'r', '!', 0x1A, 0x07)
                    || startsWith(head, 'B', 'Z', 'h')
                    || startsWith(head, 0xFD, '7', 'z', 'X', 'Z', 0);
        }

        private static boolean startsWith(byte[] head, int... prefix) {
            if (head.length < prefix.length) {
                return false;
            }
            for (int i = 0; i < prefix.length; i++) {
                if ((head[i] & 0xFF) != prefix[i]) {
                    return false;
                }
            }
            return true;
        }
    }
}
