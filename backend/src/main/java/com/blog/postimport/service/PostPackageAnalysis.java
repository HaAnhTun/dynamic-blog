package com.blog.postimport.service;

import com.blog.postimport.dto.PostImportNote;
import com.blog.postimport.dto.PostImportProblem;
import com.blog.postimport.dto.PostPackageFacts;
import com.blog.postimport.format.ParsedPost;
import com.blog.postimport.format.PostFileLimits;
import com.blog.postimport.format.PostKey;
import com.blog.postimport.format.PostPackage;
import com.blog.postimport.format.PostPackageRefs;
import com.blog.postimport.format.PostPackageRefs.Ref;
import com.blog.postimport.format.PostPackageRefs.Scan;
import com.blog.postimport.format.PostPackageRefs.Target;
import com.blog.postimport.service.PostUploads.Upload;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What the article of a readable ZIP package says about the package: which images it uses, which it leaves unused, and the
 * problems of the package (an image that is not in it, unsafe content, an entry that cannot be used). Reads nothing but the
 * upload, so a preview and an apply decide the same from the same bytes.
 *
 * <p>The cover image ({@code cover}) is an image of the package too: it counts as used, is not listed in {@link Result#used}
 * (that list is what the body shows) and is reported in {@link Result#cover} when it is a usable image.
 *
 * <p>The problems say a line of the article file and a fixed sentence; only the path of a missing image is the author's own
 * text, cut to {@link PostFileLimits#MAX_ECHOED_PATH_CHARS} characters, and it goes to the person who uploaded the package
 * in a preview and to nobody else (never to a log, and never in the refusal of an apply, which the error handler logs).
 */
final class PostPackageAnalysis {

    /** An image of the package that the article names, with the places that name it and the first description given. */
    record Used(PostPackage.Asset asset, String alt, List<Ref> refs) {}

    /** The most problems an analysis lists: a hostile article could name thousands of missing images. */
    static final int MAX_PROBLEMS = 2 * PostFileLimits.MAX_PROBLEMS;

    private PostPackageAnalysis() {}

    record Result(
            List<PostImportProblem> problems,
            List<PostImportNote> notes,
            PostPackageFacts facts,
            List<Used> used,
            Scan scan,
            PostPackage.Asset cover) {}

    /**
     * The analysis of a package that was read and whose front matter could be read.
     *
     * @param echoPaths whether a problem may name the path of an image as the author wrote it (cut). True for what goes to the
     *     uploader only (a preview); false for the refusal of an apply, whose message is written to the log by the error
     *     handler, so that it holds the line and nothing of the text
     */
    static Result of(Upload upload, ParsedPost parsed, boolean echoPaths) {
        PostPackage pack = upload.pack();
        String body = parsed.values().content();
        Scan scan = PostPackageRefs.scan(body);
        // The body starts at this line of the file; the scan counts from 1.
        int firstLine = Math.max(parsed.bodyLine(), 1);
        int position = upload.position();
        List<PostImportProblem> problems = new ArrayList<>();
        for (String message : pack.problems()) {
            problems.add(new PostImportProblem(position, null, null, message));
        }
        Map<String, PostPackage.Asset> byPath = new HashMap<>();
        for (PostPackage.Asset asset : pack.assets()) {
            byPath.put(asset.path(), asset);
        }
        Map<PostPackage.Asset, Used> used = new LinkedHashMap<>();
        for (Ref ref : scan.refs()) {
            Target target = PostPackageRefs.resolve(ref.raw());
            switch (target.kind()) {
                case REMOTE -> {}
                case ESCAPES -> {
                    if (ref.image()) {
                        problems.add(problem(
                                position,
                                firstLine + ref.line() - 1,
                                echoPaths
                                        ? "the image path \"" + cut(ref.raw()) + "\" points outside the package"
                                        : "an image path points outside the package"));
                    }
                }
                case LOCAL -> {
                    PostPackage.Asset asset = byPath.get(target.path());
                    if (asset == null) {
                        if (ref.image()) {
                            problems.add(problem(
                                    position,
                                    firstLine + ref.line() - 1,
                                    echoPaths
                                            ? "the image \"" + cut(ref.raw()) + "\" is not in the package"
                                            : "an image is not in the package"));
                        }
                    } else {
                        Used entry = used.computeIfAbsent(asset, key -> new Used(key, null, new ArrayList<>()));
                        entry.refs().add(ref);
                        if (entry.alt() == null
                                && ref.alt() != null
                                && !ref.alt().isBlank()) {
                            used.put(asset, new Used(asset, ref.alt(), entry.refs()));
                        }
                    }
                }
            }
        }
        PostPackage.Asset cover = coverOf(parsed, byPath, position, echoPaths, problems);
        for (PostPackageRefs.Finding finding : scan.unsafe()) {
            problems.add(problem(position, firstLine + finding.line() - 1, finding.message()));
        }
        List<PostImportNote> notes = new ArrayList<>();
        for (PostPackage.Asset asset : pack.assets()) {
            if (!used.containsKey(asset) && asset != cover) {
                notes.add(new PostImportNote(PostImportNote.ASSET_UNUSED, cut(asset.path()), null));
            }
        }
        int usedCount = used.size() + (cover != null && !used.containsKey(cover) ? 1 : 0);
        PostPackageFacts facts = new PostPackageFacts(
                pack.entries(),
                pack.assets().size(),
                pack.assetBytes(),
                usedCount,
                pack.assets().size() - usedCount,
                pack.unsupportedItems());
        List<PostImportProblem> listed =
                problems.size() > MAX_PROBLEMS ? List.copyOf(problems.subList(0, MAX_PROBLEMS)) : List.copyOf(problems);
        return new Result(listed, List.copyOf(notes), facts, List.copyOf(used.values()), scan, cover);
    }

    /**
     * The image the {@code cover} key names, or null when the file gives none or the key is a problem: a path that is not in
     * the package, that leaves it, or that is not a JPEG, PNG or WebP image. Resolved like the path of a body image.
     */
    private static PostPackage.Asset coverOf(
            ParsedPost parsed,
            Map<String, PostPackage.Asset> byPath,
            int position,
            boolean echoPaths,
            List<PostImportProblem> problems) {
        String raw = parsed.values().cover();
        if (raw == null) {
            return null;
        }
        Integer line = parsed.lines().get(PostKey.COVER);
        String key = PostKey.COVER.keyName();
        Target target = PostPackageRefs.resolve(raw);
        if (target.kind() == PostPackageRefs.Kind.ESCAPES) {
            problems.add(new PostImportProblem(
                    position,
                    key,
                    line,
                    echoPaths
                            ? "the cover path \"" + cut(raw) + "\" points outside the package"
                            : "the cover path points outside the package"));
            return null;
        }
        PostPackage.Asset asset = target.kind() == PostPackageRefs.Kind.LOCAL ? byPath.get(target.path()) : null;
        if (asset == null) {
            problems.add(new PostImportProblem(
                    position,
                    key,
                    line,
                    echoPaths
                            ? "the cover \"" + cut(raw) + "\" is not in the package"
                            : "the cover is not in the package"));
            return null;
        }
        if (asset.format() == null) {
            problems.add(new PostImportProblem(position, key, line, "the cover is not a JPEG, PNG or WebP image"));
            return null;
        }
        return asset;
    }

    private static PostImportProblem problem(int position, int line, String message) {
        return new PostImportProblem(position, null, line, message);
    }

    /** The path as the author wrote it, cut; a surrogate pair is never split. */
    static String cut(String value) {
        int max = PostFileLimits.MAX_ECHOED_PATH_CHARS;
        if (value.length() <= max) {
            return value;
        }
        int end = Character.isHighSurrogate(value.charAt(max - 1)) ? max - 1 : max;
        return value.substring(0, end);
    }
}
