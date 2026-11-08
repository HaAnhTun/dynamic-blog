package com.blog.siteimport.service;

import com.blog.postimport.dto.PostImportNote;
import com.blog.postimport.dto.PostPackageFacts;
import com.blog.postimport.format.PostFileLimits;
import com.blog.postimport.format.PostPackage;
import com.blog.postimport.format.PostPackageRefs;
import com.blog.postimport.format.PostPackageRefs.Ref;
import com.blog.postimport.format.PostPackageRefs.Scan;
import com.blog.postimport.format.PostPackageRefs.Target;
import com.blog.siteimport.dto.ImportProblem;
import com.blog.siteimport.format.ParsedProfile;
import com.blog.siteimport.format.ParsedProfile.ParsedSection;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import tools.jackson.databind.JsonNode;

/**
 * What a site profile file says about the images of its ZIP package: the photo of the About section, the images that the
 * About page body names and the logos of the Timeline entries. Reads nothing but the parsed file and the package, so a preview and an apply decide the same from the
 * same bytes. A problem names a line and a fixed sentence; only the path of a missing image is the author's own text, cut, and
 * it goes to the uploader in a preview and never into the refusal of an apply (which the error handler logs).
 */
final class SiteImportImages {

    static final String ABOUT = "about";
    static final String ABOUT_PAGE = "about-page";
    static final String PHOTO = "photo";
    static final String TIMELINE = "timeline";
    static final String LOGO = "logo";

    /** An image the site already stores (uploaded or imported): the only non-package value the photo field keeps. */
    private static final Pattern STORED_PATH =
            Pattern.compile("/media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(jpg|png)");

    /** An image of the package that the body names, with the places that name it and the first description given. */
    record Used(PostPackage.Asset asset, String alt, List<Ref> refs) {}

    /**
     * What the file says about the package.
     *
     * @param problems blocking problems by section id; the key {@code ""} holds the problems of the package itself
     * @param photo the image the photo field names, null when it names none
     * @param body the images the About page body names
     * @param logos the image each Timeline entry names as its logo, by the position of the entry in the file
     */
    record Plan(
            Map<String, List<ImportProblem>> problems,
            List<PostImportNote> notes,
            PostPackageFacts facts,
            PostPackage.Asset photo,
            List<Used> body,
            Map<Integer, PostPackage.Asset> logos) {

        static final Plan NONE = new Plan(Map.of(), List.of(), null, null, List.of(), Map.of());
    }

    private SiteImportImages() {}

    /**
     * @param pack the package, null for a plain Markdown file (it cannot carry images: an assets/ path is a problem)
     * @param echoPaths whether a problem may name the path of a missing image (a preview) or not (an apply)
     */
    static Plan analyse(ParsedProfile parsed, PostPackage pack, boolean echoPaths) {
        Map<String, List<ImportProblem>> problems = new LinkedHashMap<>();
        Map<String, PostPackage.Asset> byPath = new HashMap<>();
        if (pack != null) {
            pack.assets().forEach(asset -> byPath.put(asset.path(), asset));
        }
        PostPackage.Asset photo = null;
        ParsedSection about = section(parsed, ABOUT);
        if (about != null && about.patch().path(PHOTO).isString()) {
            photo = imageOf(
                    about.patch().get(PHOTO).asString(),
                    about.lines().getOrDefault("/" + PHOTO, about.line()),
                    ABOUT,
                    PHOTO,
                    pack,
                    byPath,
                    problems,
                    echoPaths);
        }
        Map<Integer, PostPackage.Asset> logos = new LinkedHashMap<>();
        ParsedSection timeline = section(parsed, TIMELINE);
        if (timeline != null) {
            JsonNode entries = timeline.patch().path("entries");
            for (int i = 0; i < entries.size(); i++) {
                if (entries.get(i).path(LOGO).isString()) {
                    String pointer = "/entries/" + i;
                    PostPackage.Asset logo = imageOf(
                            entries.get(i).get(LOGO).asString(),
                            timeline.lines().getOrDefault(pointer + "/" + LOGO, timeline.line()),
                            TIMELINE,
                            LOGO,
                            pack,
                            byPath,
                            problems,
                            echoPaths);
                    if (logo != null) {
                        logos.put(i, logo);
                    }
                }
            }
        }
        Map<PostPackage.Asset, Used> used = new LinkedHashMap<>();
        ParsedSection page = section(parsed, ABOUT_PAGE);
        if (pack != null && page != null && page.patch().path("body").isString()) {
            String body = page.patch().get("body").asString();
            int first = page.lines().getOrDefault("/body", page.line());
            Scan scan = PostPackageRefs.scan(body);
            for (Ref ref : scan.refs()) {
                Target target = PostPackageRefs.resolve(ref.raw());
                int line = first + ref.line() - 1;
                if (target.kind() == PostPackageRefs.Kind.ESCAPES && ref.image()) {
                    add(problems, ABOUT_PAGE, null, line, "an image path points outside the package");
                } else if (target.kind() == PostPackageRefs.Kind.LOCAL) {
                    PostPackage.Asset asset = byPath.get(target.path());
                    if (asset == null) {
                        if (ref.image()) {
                            add(problems, ABOUT_PAGE, null, line, missing(ref.raw(), echoPaths));
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
            scan.unsafe().forEach(f -> add(problems, ABOUT_PAGE, null, first + f.line() - 1, f.message()));
        }
        if (pack == null) {
            return new Plan(problems, List.of(), null, null, List.of(), Map.of());
        }
        for (String message : pack.problems()) {
            problems.computeIfAbsent("", key -> new ArrayList<>()).add(new ImportProblem(null, null, null, message));
        }
        List<PostImportNote> notes = new ArrayList<>();
        int usedCount = 0;
        for (PostPackage.Asset asset : pack.assets()) {
            if (used.containsKey(asset) || asset.equals(photo) || logos.containsValue(asset)) {
                usedCount++;
            } else {
                notes.add(new PostImportNote(PostImportNote.ASSET_UNUSED, cut(asset.path()), null));
            }
        }
        PostPackageFacts facts = new PostPackageFacts(
                pack.entries(),
                pack.assets().size(),
                pack.assetBytes(),
                usedCount,
                pack.assets().size() - usedCount,
                pack.unsupportedItems());
        return new Plan(problems, List.copyOf(notes), facts, photo, List.copyOf(used.values()), logos);
    }

    /**
     * The image of the package a photo or logo value names. A path of an image the site already stores is kept as it is and
     * names none; a path in the package needs the package and must be in it; anything else is left to the validators.
     */
    private static PostPackage.Asset imageOf(
            String raw,
            int line,
            String sectionId,
            String field,
            PostPackage pack,
            Map<String, PostPackage.Asset> byPath,
            Map<String, List<ImportProblem>> problems,
            boolean echoPaths) {
        Target target = STORED_PATH.matcher(raw).matches() ? null : PostPackageRefs.resolve(raw);
        if (target != null && target.kind() == PostPackageRefs.Kind.LOCAL) {
            PostPackage.Asset asset = byPath.get(target.path());
            if (pack == null) {
                add(
                        problems,
                        sectionId,
                        field,
                        line,
                        "an image path needs a ZIP package: import a .zip with the image under assets/");
            } else if (asset == null) {
                add(problems, sectionId, field, line, missing(raw, echoPaths));
            }
            return asset;
        }
        if (target != null && target.kind() == PostPackageRefs.Kind.ESCAPES) {
            add(problems, sectionId, field, line, "the image path points outside the package");
        }
        return null;
    }

    private static ParsedSection section(ParsedProfile parsed, String id) {
        return parsed.sections().stream()
                .filter(s -> s.descriptor().id().equals(id))
                .findFirst()
                .orElse(null);
    }

    private static void add(
            Map<String, List<ImportProblem>> problems, String section, String field, int line, String reason) {
        problems.computeIfAbsent(section, key -> new ArrayList<>())
                .add(new ImportProblem(section, field, line, reason));
    }

    private static String missing(String raw, boolean echoPaths) {
        return echoPaths ? "the image \"" + cut(raw) + "\" is not in the package" : "an image is not in the package";
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
