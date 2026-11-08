package com.blog.postimport.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.postimport.format.ParsedPost;
import com.blog.postimport.format.PostFile;
import com.blog.postimport.format.PostFileLimits;
import com.blog.postimport.format.PostMarkdownParser;
import com.blog.postimport.format.PostPackage;
import com.blog.postimport.format.PostPackageReader;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.springframework.http.HttpStatus;
import org.springframework.web.multipart.MultipartFile;

/**
 * Reads the file parts of a post import request: the count and size limits, the name, the strict decoding. The refusals never
 * contain anything from a file: a file is named by its position in the upload (1-based) and a place by a line number.
 *
 * <p>A part is a ZIP package when its name ends in {@code .zip}, or when it is not named {@code .md} and starts with the ZIP
 * magic bytes ({@code PK}). A package that cannot be read is not a refusal of the request: it is an upload with the reason
 * ({@link PostPackage#problems()}), so that the files next to it still get their answers.
 */
final class PostUploads {

    /**
     * One file. For a Markdown file {@code text} is the output of {@link PostFile#decode} and {@code pack} is null; for a ZIP
     * package {@code text} is the decoded article file ({@code ""} when the package was refused) and {@code pack} is what the
     * reader made of it.
     */
    record Upload(int position, String fileName, int bytes, String sha256, String text, PostPackage pack) {

        Upload(int position, String fileName, int bytes, String sha256, String text) {
            this(position, fileName, bytes, sha256, text, null);
        }
    }

    /** A file name is echoed back to its uploader, cut to this length. */
    static final int MAX_NAME_CHARS = 255;

    private PostUploads() {}

    /**
     * 400 {@code POST_IMPORT_INVALID_FILE} when there is no file part, more than {@link PostFileLimits#MAX_FILES} parts, or a
     * file is not a readable {@code .md} text; 413 {@code VALIDATION_ERROR} when a file is over {@link PostFile#MAX_BYTES} or
     * the files together are over {@link PostFileLimits#MAX_TOTAL_BYTES}. The sizes are checked before any file is read.
     */
    static List<Upload> read(List<MultipartFile> files) {
        if (files == null || files.isEmpty()) {
            throw invalid("At least one .md file is required");
        }
        if (files.size() > PostFileLimits.MAX_FILES) {
            throw invalid("At most " + PostFileLimits.MAX_FILES + " files can be imported at once");
        }
        long total = 0;
        for (int i = 0; i < files.size(); i++) {
            long size = files.get(i).getSize();
            int cap = isZipName(files.get(i).getOriginalFilename())
                    ? PostFileLimits.MAX_PACKAGE_BYTES
                    : PostFile.MAX_BYTES;
            if (size > cap) {
                throw tooLarge("File " + (i + 1) + " is larger than " + cap + " bytes");
            }
            total += size;
        }
        if (total > PostFileLimits.MAX_TOTAL_BYTES) {
            throw tooLarge("The files together are larger than " + PostFileLimits.MAX_TOTAL_BYTES + " bytes");
        }
        List<Upload> uploads = new ArrayList<>(files.size());
        // What the packages of this request may unpack to, all together.
        long[] unpackBudget = {PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES};
        for (int i = 0; i < files.size(); i++) {
            uploads.add(one(i + 1, files.get(i), unpackBudget));
        }
        return List.copyOf(uploads);
    }

    /** The parse of an upload: a Markdown file as it is, a package by its article file, a refused package as unreadable. */
    static ParsedPost parse(Upload upload) {
        PostPackage pack = upload.pack();
        if (pack == null) {
            return PostMarkdownParser.parse(upload.position(), upload.fileName(), upload.text());
        }
        if (!pack.readable()) {
            return ParsedPost.refused(upload.position(), pack.problems().get(0));
        }
        return PostMarkdownParser.parse(upload.position(), slugName(upload.fileName()), upload.text());
    }

    /** The name of a package stands for the name of its article when the slug comes from the file name: {@code a.zip} is {@code a.md}. */
    private static String slugName(String packageName) {
        return isZipName(packageName)
                ? packageName.substring(0, packageName.length() - ".zip".length()) + ".md"
                : packageName;
    }

    static boolean isZipName(String name) {
        return name != null && name.toLowerCase(Locale.ROOT).endsWith(".zip");
    }

    private static boolean isMarkdownName(String name) {
        return name != null && name.toLowerCase(Locale.ROOT).endsWith(".md");
    }

    private static Upload one(int position, MultipartFile file, long[] unpackBudget) {
        try {
            String name = file.getOriginalFilename();
            if (isZipName(name) || !isMarkdownName(name)) {
                byte[] bytes = file.getBytes();
                if (isZipName(name) || startsWithZipMagic(bytes)) {
                    return packageUpload(position, name, bytes, unpackBudget);
                }
            }
            PostFile.requireMarkdownName(file.getOriginalFilename());
            byte[] bytes = file.getBytes();
            return new Upload(
                    position,
                    plainName(file.getOriginalFilename()),
                    bytes.length,
                    PostFile.sha256Hex(bytes),
                    PostFile.decode(bytes));
        } catch (IOException e) {
            throw invalid("File " + position + " could not be read");
        } catch (ApiException e) {
            // The decoder's messages hold sizes and line numbers only; say which file they are about.
            throw new ApiException(e.getCode(), e.getStatus(), "File " + position + ": " + e.getMessage());
        }
    }

    private static Upload packageUpload(int position, String name, byte[] bytes, long[] unpackBudget) {
        PostPackage pack = PostPackageReader.read(bytes, unpackBudget[0]);
        unpackBudget[0] = Math.max(0, unpackBudget[0] - pack.unpackedBytes());
        return new Upload(
                position,
                plainName(name),
                bytes.length,
                PostFile.sha256Hex(bytes),
                pack.readable() ? pack.markdown() : "",
                pack);
    }

    private static boolean startsWithZipMagic(byte[] bytes) {
        return bytes.length >= 4 && bytes[0] == 'P' && bytes[1] == 'K' && (bytes[2] == 3 || bytes[2] == 5);
    }

    /** The name the browser sent without any directory part, at most {@link #MAX_NAME_CHARS} characters. */
    static String plainName(String originalFilename) {
        if (originalFilename == null) {
            return "";
        }
        int slash = Math.max(originalFilename.lastIndexOf('/'), originalFilename.lastIndexOf('\\'));
        String name = originalFilename.substring(slash + 1);
        return name.length() > MAX_NAME_CHARS ? name.substring(0, MAX_NAME_CHARS) : name;
    }

    private static ApiException invalid(String message) {
        return new ApiException(ErrorCode.POST_IMPORT_INVALID_FILE, HttpStatus.BAD_REQUEST, message);
    }

    private static ApiException tooLarge(String message) {
        return new ApiException(ErrorCode.VALIDATION_ERROR, HttpStatus.CONTENT_TOO_LARGE, message);
    }
}
