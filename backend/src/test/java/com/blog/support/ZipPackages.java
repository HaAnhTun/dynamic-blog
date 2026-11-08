package com.blog.support;

import static java.nio.charset.StandardCharsets.UTF_8;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/** Builds the ZIP packages (and the hostile archives) that the post import tests upload. */
public final class ZipPackages {

    private static final int CENTRAL = 0x02014b50;

    private ZipPackages() {}

    /** A small valid image of the test resources ({@code /media/<name>}). */
    public static byte[] image(String name) {
        try (InputStream in = ZipPackages.class.getResourceAsStream("/media/" + name)) {
            if (in == null) {
                throw new IllegalStateException("missing test image " + name);
            }
            return in.readAllBytes();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public static Builder zip() {
        return new Builder();
    }

    public static final class Builder {

        private record Item(String name, byte[] data, boolean stored) {}

        private final List<Item> items = new ArrayList<>();

        public Builder add(String name, byte[] data) {
            items.add(new Item(name, data, false));
            return this;
        }

        public Builder add(String name, String text) {
            return add(name, text.getBytes(UTF_8));
        }

        /** An entry written without compression. */
        public Builder store(String name, byte[] data) {
            items.add(new Item(name, data, true));
            return this;
        }

        /** A folder entry; the name needs no closing slash. */
        public Builder folder(String name) {
            items.add(new Item(name.endsWith("/") ? name : name + "/", new byte[0], true));
            return this;
        }

        public byte[] build() {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (ZipOutputStream out = new ZipOutputStream(bytes)) {
                for (Item item : items) {
                    ZipEntry entry = new ZipEntry(item.name());
                    if (item.stored()) {
                        CRC32 crc = new CRC32();
                        crc.update(item.data());
                        entry.setMethod(ZipEntry.STORED);
                        entry.setSize(item.data().length);
                        entry.setCompressedSize(item.data().length);
                        entry.setCrc(crc.getValue());
                    }
                    out.putNextEntry(entry);
                    out.write(item.data());
                    out.closeEntry();
                }
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
            return bytes.toByteArray();
        }
    }

    /** A post file: front matter with the given lines, then the body. */
    public static String article(String body, String... frontMatter) {
        return "---\n" + String.join("\n", frontMatter) + "\n---\n\n" + body;
    }

    /** Sets bytes of the central directory record of the entry {@code index} (0-based): {@code patch} gets its first byte. */
    public static byte[] patchCentral(byte[] zip, int index, CentralPatch patch) {
        byte[] copy = zip.clone();
        ByteBuffer buffer = ByteBuffer.wrap(copy).order(ByteOrder.LITTLE_ENDIAN);
        int seen = -1;
        for (int at = 0; at + 4 <= copy.length; at++) {
            if (buffer.getInt(at) == CENTRAL) {
                seen++;
                if (seen == index) {
                    patch.apply(buffer, at);
                    return copy;
                }
            }
        }
        throw new IllegalStateException("no central directory record " + index);
    }

    /** Marks the entry as a symbolic link of a Unix system. */
    public static byte[] asSymlink(byte[] zip, int index) {
        return patchCentral(zip, index, (buffer, at) -> {
            buffer.putShort(at + 4, (short) ((3 << 8) | 20));
            buffer.putInt(at + 38, 0xA1FF << 16);
        });
    }

    /** Sets the encryption flag of the entry. */
    public static byte[] asEncrypted(byte[] zip, int index) {
        return patchCentral(zip, index, (buffer, at) -> buffer.putShort(at + 8, (short) (buffer.getShort(at + 8) | 1)));
    }

    /** Replaces every occurrence of a text in the archive by a text of the same length (a name, in the headers). */
    public static byte[] replaceAll(byte[] zip, String from, String to) {
        byte[] a = from.getBytes(UTF_8);
        byte[] b = to.getBytes(UTF_8);
        if (a.length != b.length) {
            throw new IllegalArgumentException("same length needed");
        }
        byte[] copy = zip.clone();
        for (int i = 0; i + a.length <= copy.length; i++) {
            boolean match = true;
            for (int j = 0; j < a.length && match; j++) {
                match = copy[i + j] == a[j];
            }
            if (match) {
                System.arraycopy(b, 0, copy, i, b.length);
            }
        }
        return copy;
    }

    @FunctionalInterface
    public interface CentralPatch {
        void apply(ByteBuffer buffer, int recordStart);
    }
}
