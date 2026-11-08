package com.blog.postimport.service;

import com.blog.category.dto.CategoryRequest;
import com.blog.category.service.CategoryService;
import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.Languages;
import com.blog.common.quota.AuthorQuotaProperties;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.common.util.SlugGenerator;
import com.blog.media.entity.Media;
import com.blog.media.repository.MediaRepository;
import com.blog.media.service.ImageFormat;
import com.blog.media.service.ImageProcessor;
import com.blog.media.service.MediaService;
import com.blog.media.service.PreparedUpload;
import com.blog.post.dto.PostCreateRequest;
import com.blog.post.dto.PostResponse;
import com.blog.post.dto.PostUpdateRequest;
import com.blog.post.entity.Post;
import com.blog.post.entity.PostStatus;
import com.blog.post.repository.PostRepository;
import com.blog.post.service.PostCoverService;
import com.blog.post.service.PostRevisionService;
import com.blog.post.service.PostService;
import com.blog.postimport.dto.PostAppliedFile;
import com.blog.postimport.dto.PostApplyResponse;
import com.blog.postimport.dto.PostArticlePreviewResponse;
import com.blog.postimport.dto.PostImportNote;
import com.blog.postimport.dto.PostImportProblem;
import com.blog.postimport.dto.PostImportStatusResponse;
import com.blog.postimport.dto.PostImportStatusResponse.LastPostImport;
import com.blog.postimport.dto.PostPackageFacts;
import com.blog.postimport.dto.PostPreviewChanges;
import com.blog.postimport.dto.PostPreviewChanges.Change;
import com.blog.postimport.dto.PostPreviewChanges.PartChange;
import com.blog.postimport.dto.PostPreviewFile;
import com.blog.postimport.dto.PostPreviewResponse;
import com.blog.postimport.format.ParsedPost;
import com.blog.postimport.format.PostFile;
import com.blog.postimport.format.PostFileLimits;
import com.blog.postimport.format.PostFileValues;
import com.blog.postimport.format.PostKey;
import com.blog.postimport.format.PostNormalForm;
import com.blog.postimport.format.PostPackage;
import com.blog.postimport.format.PostPackageRefs;
import com.blog.postimport.format.PostPackageRefs.Ref;
import com.blog.postimport.format.PostTemplateGenerator;
import com.blog.postimport.format.SlugSource;
import com.blog.postimport.repository.PostImportRepository;
import com.blog.postimport.repository.PostImportRepository.LogRow;
import com.blog.postimport.service.PostPackageAnalysis.Used;
import com.blog.postimport.service.PostUploads.Upload;
import com.blog.postimport.service.TaxonomyResolver.Entry;
import com.blog.postimport.service.TaxonomyResolver.Result;
import com.blog.series.dto.SeriesRequest;
import com.blog.series.entity.Series;
import com.blog.series.repository.SeriesRepository;
import com.blog.series.service.SeriesService;
import com.blog.siteimport.dto.MarkdownDownload;
import com.blog.tag.dto.TagRequest;
import com.blog.tag.entity.Tag;
import com.blog.tag.service.TagService;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.function.Supplier;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.multipart.MultipartFile;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * The post import ({@code docs/post-file-format.md}): the template, the preview, the apply (new posts and updates of existing
 * ones) and the status of the caller's latest import. Open to admins and authors
 * ({@code /api/v1/admin/post-import/**} is in SecurityConfig's AUTHOR list), so the service itself decides which posts the caller
 * may manage: an admin any post, an author only the author's own.
 *
 * <p>A preview writes nothing: it runs in a read-only transaction and only reads posts, categories and tags. Nothing it
 * answers with a problem, and nothing it logs, holds text from a file: a file is named by its position, a key by its name in
 * the format, a place by a line number. A success answer goes only to the caller who uploaded the files and may hold the file
 * name, the slug, the title, description and category (cut) and the names to create.
 *
 * <p>An apply writes in one transaction, under the translation-writes lock (the first lock of any transaction that writes
 * translation groups) and then the import-wide lock, and decides everything from what it reads under them. A new post goes
 * through {@link PostService#create}, as a draft owned by the caller, and a file whose final slug is the current slug of a post
 * the caller may manage updates that post through {@link PostService#update} with the stored value for everything the file
 * leaves out or supplies equal (the update replaces the whole post), so slugs, search indexing, revisions and the rules of the
 * editor apply; the import never publishes, never changes a status, an author, a language or a slug, and never touches
 * {@code featured}. The cover of a ZIP package is the exception that replaces what is there: see below. An administrator's file may also put the post in a series ({@link SeriesService}): see the
 * series paragraph below. Whatever a service throws while writing becomes one stable import error with the file
 * position only: no message of a service and no database detail reaches the caller or a log line.
 *
 * <p>A file may also be a ZIP package: one article and the images it uses ({@link PostPackage}). The article goes through
 * everything above like a Markdown file. The images of a package are stored only by an apply, and only the ones the article
 * uses: they are prepared (decoded, resized, re-encoded) BEFORE the transaction, because the image pipeline takes a processing
 * permit and must not hold a database connection while it works; inside the transaction each one is stored as an image of the
 * post ({@link MediaService#persistForPost}) and the references in the body are rewritten to their {@code /media/} paths, so
 * a rollback takes the images away with the post.
 *
 * <p>A package may also name its cover ({@code cover}, {@code cover_alt}). The cover image is prepared with the others, before
 * the transaction, and stored through {@link PostCoverService#replace} as the editor's cover upload does: a new post gets it, an
 * existing post gets it in place of the cover it has (the package wins), the old image is deleted. A cover whose bytes equal the
 * stored cover, with the same description, is no change. The state a preview hands out covers the stored cover.
 */
@Service
@RequiredArgsConstructor
public class PostImportService {

    private static final Logger log = LoggerFactory.getLogger(PostImportService.class);

    /** The same sentence for a slug of someone else's post and for an old slug: the answer reveals nothing more. */
    static final String SLUG_NOT_AVAILABLE = "this slug is not available; choose another slug";

    /** Problems named in the message of a rejected apply; the answer says how many more there are. */
    static final int MAX_MESSAGE_PROBLEMS = 10;

    static final String ACTION_CREATED = "created";
    static final String ACTION_UPDATED = "updated";

    private static final String DRAFT = "draft";
    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;

    private final PostRepository postRepository;
    private final CategoryService categoryService;
    private final TagService tagService;
    private final Languages languages;
    private final RateLimiter rateLimiter;
    private final PostTemplateGenerator templateGenerator;
    private final PostService postService;
    private final PostRevisionService postRevisionService;
    private final PostImportRepository importRepository;
    private final ObjectMapper objectMapper;
    private final MediaService mediaService;
    private final MediaRepository mediaRepository;
    private final PlatformTransactionManager transactionManager;
    private final SeriesRepository seriesRepository;
    private final SeriesService seriesService;
    private final PostCoverService postCoverService;
    private final AuthorQuotaProperties authorQuota;

    /** The template of one language; an absent language is the site's default. Not rate limited: it is a static download. */
    public MarkdownDownload template(String language) {
        String wanted = languages.orDefault(language);
        return new MarkdownDownload("post-template-" + wanted + ".md", templateGenerator.template(wanted));
    }

    /**
     * What importing the files would do. Writes nothing; problems of a file are part of the answer, not an error. Counts as one
     * use of the post import bucket, like an apply or an undo.
     *
     * @param admin whether the caller is an admin (any post may be managed) or an author (own posts only)
     */
    @Transactional(readOnly = true)
    public PostPreviewResponse preview(List<MultipartFile> files, UUID userId, boolean admin) {
        rateLimiter.check(RateLimiter.POST_IMPORT_WRITE, userId);
        List<Upload> uploads = PostUploads.read(files);
        List<ParsedPost> parsed = uploads.stream().map(PostUploads::parse).toList();
        Preview preview = new Preview(userId, admin, parsed);
        List<PostPreviewFile> previews = new ArrayList<>();
        for (int i = 0; i < uploads.size(); i++) {
            previews.add(preview.file(uploads.get(i), parsed.get(i)));
        }
        PostPreviewResponse response = response(
                previews,
                preview.createdCategories.size(),
                preview.createdTags.size(),
                preview.createdSeries.size(),
                uploads.stream().mapToInt(Upload::bytes).sum());
        log.info(
                "post import previewed files={} filesWithProblems={} bytes={}",
                response.files().size(),
                response.filesWithProblems().size(),
                response.totalBytes());
        return response;
    }

    // --- Apply ---------------------------------------------------------------------------------------------

    /** A selected file the apply will write, with what the plan computed for it under the locks. {@code update} is null for a new post. */
    private record Planned(Upload upload, ParsedPost parsed, PostPreviewFile file, Update update) {}

    /**
     * What the import knows about an existing post it matched: the state it has now (what the preview state is made of, and what
     * the log keeps to put back) and, when the file changes it, the merged values. A value the file leaves out, or supplies
     * equal in the normal form, is the stored one. {@code categoryName} and {@code tagNames} are null when the stored category or
     * tags stay; otherwise they are the file's names, resolved (and created when missing) when the post is written.
     */
    private record Update(
            UUID postId,
            String slug,
            String status,
            String language,
            String stateHash,
            UUID categoryBefore,
            List<UUID> tagsBefore,
            String title,
            String excerpt,
            String content,
            String categoryName,
            List<String> tagNames,
            boolean textChanges,
            boolean postChanges,
            boolean differs,
            PostPreviewChanges changes,
            SeriesJoin series,
            UUID seriesBeforeId,
            Integer seriesPositionBefore,
            Integer seriesPartBefore,
            boolean coverChanges,
            boolean coverReplaces) {

        /** The opaque state the preview hands out for this post and the apply compares. */
        String previewState() {
            return new PreviewState(PreviewState.ACTION_UPDATE, postId, status, comparedHash()).encode();
        }

        boolean isPreviewed(Optional<PreviewState> state) {
            return state.filter(decoded -> PreviewState.ACTION_UPDATE.equals(decoded.action()))
                    .filter(decoded -> postId.equals(decoded.postId())
                            && status.equals(decoded.status())
                            && comparedHash().equals(decoded.stateHash()))
                    .isPresent();
        }

        /** The hash of the stored post, and what the file does with a series when it joins one. */
        private String comparedHash() {
            return series == null ? stateHash : sha256(stateHash + "|" + series.fingerprint());
        }
    }

    /**
     * Joining a series: an existing one ({@code seriesId}) or one to create by {@code name} (seriesId null), at the part the
     * file declares ({@code part} is null when the post already has its place and the file only gives a description).
     * {@code description} is the one this file sets, null when it sets none: the file that creates the series gives it to the
     * new series, and the first file to give one to a series that has none fills it in. A series that has a description, and
     * every file after the first to describe it, are not given one here.
     */
    private record SeriesJoin(UUID seriesId, String name, String description, Integer part) {

        /** Which series, which part and whether a description is set, as the preview saw it: the apply refuses to do something else. */
        String fingerprint() {
            return (seriesId == null ? "create" : seriesId.toString()) + ":" + (part == null ? "-" : part.toString())
                    + (description == null ? "" : ":described");
        }

        /** The same fingerprint as a hash, for the state of a new post. */
        String stateHash() {
            return sha256(fingerprint());
        }

        /** The same series from one file to the next, whatever the case or the accents of its name. */
        String creationKey() {
            String slug = SlugGenerator.slugifyOrEmpty(name);
            return slug.isEmpty() ? "name:" + TaxonomyResolver.fold(name) : "slug:" + slug;
        }
    }

    private static String sha256(String text) {
        return PostFile.sha256Hex(text.getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Writes the selected files, all or nothing. Every file must be the previewed one (same SHA-256), a problem in any selected
     * file rejects the whole import (400 {@code POST_IMPORT_INVALID}), and a selected file that would not be written exactly as
     * the preview said rejects it as out of date (409 {@code POST_IMPORT_PREVIEW_OUT_OF_DATE}, a count only): a new post that
     * is now an update, a post that was edited or published since, a draft that is published now. A selected file that now
     * changes nothing is not a conflict; it writes nothing.
     *
     * @param files the file parts, in the order of the preview
     * @param manifestJson the manifest part ({@link PostManifest})
     * @param admin whether the caller is an admin (any post may be managed) or an author (own posts only)
     */
    public PostApplyResponse apply(List<MultipartFile> files, String manifestJson, UUID userId, boolean admin) {
        rateLimiter.check(RateLimiter.POST_IMPORT_WRITE, userId);
        List<Upload> uploads = PostUploads.read(files);
        List<PostManifest.Item> manifest = PostManifest.parse(objectMapper, manifestJson, uploads.size());
        for (Upload upload : uploads) {
            if (!upload.sha256().equals(manifest.get(upload.position() - 1).sha256())) {
                throw new ApiException(
                        ErrorCode.POST_IMPORT_HASH_MISMATCH,
                        HttpStatus.CONFLICT,
                        "File " + upload.position() + " is not the one that was previewed; preview again");
            }
        }

        // What needs no database state: the parse and its problems, for the selected files only.
        List<Upload> chosenUploads = new ArrayList<>();
        List<ParsedPost> chosen = new ArrayList<>();
        List<PostImportProblem> parserProblems = new ArrayList<>();
        Map<Integer, PostPackageAnalysis.Result> packages = new HashMap<>();
        for (Upload upload : uploads) {
            if (!manifest.get(upload.position() - 1).selected()) {
                continue;
            }
            ParsedPost parsed = PostUploads.parse(upload);
            chosenUploads.add(upload);
            chosen.add(parsed);
            for (ParsedPost.Problem problem : parsed.problems()) {
                parserProblems.add(new PostImportProblem(
                        problem.position(),
                        problem.key() == null ? null : problem.key().keyName(),
                        problem.line(),
                        problem.message()));
            }
            if (upload.pack() != null && !parsed.unreadable()) {
                PostPackageAnalysis.Result analysis = PostPackageAnalysis.of(upload, parsed, false);
                packages.put(upload.position(), analysis);
                parserProblems.addAll(analysis.problems());
            }
        }
        if (chosen.isEmpty()) {
            throw new ApiException(
                    ErrorCode.POST_IMPORT_INVALID_FILE, HttpStatus.BAD_REQUEST, "Select at least one file");
        }
        if (!parserProblems.isEmpty()) {
            throw invalid(parserProblems);
        }

        // The images of the packages are prepared before the transaction opens: the pipeline waits for a processing
        // permit and must not hold a database connection while it decodes and encodes.
        Map<Integer, Map<String, PreparedUpload>> images = prepareImages(packages, userId);
        return new TransactionTemplate(transactionManager)
                .execute(status -> write(uploads, manifest, chosenUploads, chosen, packages, images, userId, admin));
    }

    /** The part of {@link #apply} that writes, in one transaction: everything it decides, it decides under the locks it takes first. */
    private PostApplyResponse write(
            List<Upload> uploads,
            List<PostManifest.Item> manifest,
            List<Upload> chosenUploads,
            List<ParsedPost> chosen,
            Map<Integer, PostPackageAnalysis.Result> packages,
            Map<Integer, Map<String, PreparedUpload>> images,
            UUID userId,
            boolean admin) {
        // The first lock of a transaction that writes translation groups, then the import-wide one, then the rows of
        // the posts
        // the files name. Everything below is read under them.
        postRepository.lockTranslationWrites();
        importRepository.lockGlobal();
        lockSeries(chosen, admin);
        lockMatchedPosts(chosen);

        Preview plan = new Preview(userId, admin, chosen);
        Map<Integer, Planned> planned = new LinkedHashMap<>();
        Map<Integer, Update> unchanged = new HashMap<>();
        List<PostImportProblem> problems = new ArrayList<>();
        int outOfDate = 0;
        for (int i = 0; i < chosen.size(); i++) {
            Upload upload = chosenUploads.get(i);
            PostPreviewFile file = plan.file(upload, chosen.get(i));
            String state = manifest.get(upload.position() - 1).state();
            Optional<PreviewState> previewed = PreviewState.decode(state);
            Update update = plan.updates.get(upload.position());
            switch (file.state()) {
                // A file the preview already refused is a problem of the file; one the preview accepted has changed
                // since.
                case PostPreviewFile.ERROR -> {
                    if (state == null) {
                        problems.addAll(file.problems());
                    } else {
                        outOfDate++;
                    }
                }
                case PostPreviewFile.UNCHANGED -> unchanged.put(upload.position(), update);
                case PostPreviewFile.NEW -> {
                    SeriesJoin join = plan.joins.get(upload.position());
                    if (previewed
                            .filter(decoded -> PreviewState.ACTION_NEW.equals(decoded.action()))
                            .filter(decoded ->
                                    Objects.equals(decoded.stateHash(), join == null ? null : join.stateHash()))
                            .isPresent()) {
                        planned.put(upload.position(), new Planned(upload, chosen.get(i), file, null));
                    } else {
                        // Not previewed as a new post (no state, or the state of an update) but it would be made now.
                        outOfDate++;
                    }
                }
                default -> {
                    if (update.isPreviewed(previewed)) {
                        planned.put(upload.position(), new Planned(upload, chosen.get(i), file, update));
                    } else {
                        outOfDate++;
                    }
                }
            }
        }
        if (!problems.isEmpty()) {
            throw invalid(problems);
        }
        if (outOfDate > 0) {
            throw new ApiException(
                    ErrorCode.POST_IMPORT_PREVIEW_OUT_OF_DATE,
                    HttpStatus.CONFLICT,
                    outOfDate + (outOfDate == 1 ? " file is" : " files are")
                            + " no longer as previewed; preview again");
        }

        Map<String, UUID> createdCategories = new LinkedHashMap<>();
        Map<String, UUID> createdTags = new LinkedHashMap<>();
        Map<String, UUID> createdSeries = new LinkedHashMap<>();
        List<PostAppliedFile> applied = new ArrayList<>();
        ArrayNode logItems = JSON.arrayNode();
        ArrayNode logHashes = JSON.arrayNode();
        int bytes = 0;
        int created = 0;
        int updated = 0;
        for (Upload upload : uploads) {
            Planned one = planned.get(upload.position());
            if (one == null) {
                Update same = unchanged.get(upload.position());
                applied.add(
                        same == null
                                ? new PostAppliedFile(
                                        upload.position(), upload.fileName(), PostAppliedFile.SKIPPED, null, null)
                                : new PostAppliedFile(
                                        upload.position(),
                                        upload.fileName(),
                                        PostAppliedFile.UNCHANGED,
                                        same.postId(),
                                        same.slug()));
                continue;
            }
            ObjectNode item = logItems.addObject();
            UUID postId;
            String slug;
            if (one.update() == null) {
                PostResponse post = createOne(plan, one, userId, createdCategories, createdTags);
                postId = post.id();
                slug = post.slug();
                attachImages(one, postId, userId, packages, images);
                replaceCover(one, postId, userId, packages, images);
                item.put("action", ACTION_CREATED);
                item.putNull("previousRevisionId");
                item.putNull("previousCategoryId");
                item.putArray("previousTagIds");
                item.putNull("previousSeriesId");
                item.putNull("previousSeriesPosition");
                item.putNull("previousSeriesPart");
                created++;
            } else {
                Update update = one.update();
                String content = update.content();
                if (content.equals(one.parsed().values().content())) {
                    // The text of the file is what is written: its images are stored and its references point at them.
                    content = storeImages(one, update.postId(), content, userId, packages, images);
                }
                UUID revisionId = updateOne(plan, one, userId, createdCategories, createdTags, content);
                if (update.coverChanges()) {
                    replaceCover(one, update.postId(), userId, packages, images);
                }
                postId = update.postId();
                slug = update.slug();
                item.put("action", ACTION_UPDATED);
                putNullable(item, "previousRevisionId", revisionId);
                putNullable(item, "previousCategoryId", update.categoryBefore());
                ArrayNode before = item.putArray("previousTagIds");
                update.tagsBefore().forEach(id -> before.add(id.toString()));
                putNullable(item, "previousSeriesId", update.seriesBeforeId());
                putNullable(item, "previousSeriesPosition", update.seriesPositionBefore());
                putNullable(item, "previousSeriesPart", update.seriesPartBefore());
                updated++;
            }
            SeriesJoin join = plan.joins.get(upload.position());
            UUID joined = null;
            boolean seriesCreated = false;
            if (join != null) {
                boolean known = join.seriesId() != null || createdSeries.containsKey(join.creationKey());
                joined = joinSeries(upload.position(), postId, join, createdSeries);
                seriesCreated = join.seriesId() == null && !known;
            }
            putNullable(item, "seriesId", joined);
            item.put("seriesCreated", seriesCreated);
            Post stored = postRepository
                    .findById(postId)
                    .orElseThrow(() -> new IllegalStateException("the written post is not readable"));
            item.put("postId", postId.toString());
            item.put("afterHash", PostStateHash.of(stored));
            item.put("linkCreated", false);
            logHashes.add(upload.sha256());
            bytes += upload.bytes();
            applied.add(new PostAppliedFile(
                    upload.position(),
                    upload.fileName(),
                    one.update() == null ? PostAppliedFile.CREATED : PostAppliedFile.UPDATED,
                    postId,
                    slug));
        }
        Long importId = null;
        int written = created + updated;
        if (written > 0) {
            importId = importRepository.insert(
                    userId,
                    written,
                    bytes,
                    objectMapper.writeValueAsString(logHashes),
                    objectMapper.writeValueAsString(logItems));
        }
        int skipped = uploads.size() - written - unchanged.size();
        log.info(
                "post import applied importId={} files={} created={} updated={} unchanged={} skipped={} bytes={}",
                importId,
                uploads.size(),
                created,
                updated,
                unchanged.size(),
                skipped,
                bytes);
        return new PostApplyResponse(importId, List.copyOf(applied), created, updated, unchanged.size(), skipped);
    }

    private static void putNullable(ObjectNode item, String name, UUID id) {
        if (id == null) {
            item.putNull(name);
        } else {
            item.put(name, id.toString());
        }
    }

    private static void putNullable(ObjectNode item, String name, Integer number) {
        if (number == null) {
            item.putNull(name);
        } else {
            item.put(name, number.intValue());
        }
    }

    /**
     * Row locks on the series the files of an administrator could mean by their names, in id order, after the import-wide lock
     * and before any post row. The translation-writes lock, which every other series writer takes first, already serialises them
     * with this import; the order is a second guard. A name no series answers to locks nothing: the series is created later, under
     * the import-wide lock.
     */
    private void lockSeries(List<ParsedPost> chosen, boolean admin) {
        if (!admin) {
            return;
        }
        List<String> names = chosen.stream()
                .map(parsed -> parsed.values().series())
                .filter(Objects::nonNull)
                .distinct()
                .toList();
        if (names.isEmpty()) {
            return;
        }
        List<SeriesResolver.Entry> entries = seriesEntries();
        Set<UUID> ids = new TreeSet<>();
        names.forEach(name -> ids.addAll(SeriesResolver.candidates(name, entries)));
        ids.forEach(seriesRepository::findByIdForUpdate);
    }

    private List<SeriesResolver.Entry> seriesEntries() {
        return seriesRepository.findAllByOrderByTitleAsc().stream()
                .map(PostImportService::seriesEntry)
                .toList();
    }

    private static SeriesResolver.Entry seriesEntry(Series series) {
        return new SeriesResolver.Entry(series.getId(), series.getTitle(), series.getSlug(), series.getTranslations());
    }

    /**
     * Puts the post at its declared part of the series, creating the series first when this is the first file of the apply to
     * name it (once per name, with the description of that first file). A description the plan gave to a series that exists, or
     * that an earlier file created without one, is filled in only while the series has none ({@link
     * SeriesService#fillDescriptionIfEmpty}), under the lock of the series. Whatever the services throw becomes one import error
     * with the file position only.
     *
     * @return the id of the series
     */
    private UUID joinSeries(int position, UUID postId, SeriesJoin join, Map<String, UUID> createdSeries) {
        UUID series = join.seriesId();
        boolean created = false;
        if (series == null) {
            series = createdSeries.get(join.creationKey());
            if (series == null) {
                series = guarded(position, false, () -> {
                    UUID made = seriesService
                            .create(new SeriesRequest(join.name(), null, join.description()))
                            .id();
                    // Write now, so that a violation is attributed to this file and not found at commit.
                    postRepository.flush();
                    return made;
                });
                createdSeries.put(join.creationKey(), series);
                created = true;
            }
        }
        UUID target = series;
        if (join.description() != null && !created) {
            guarded(position, false, () -> {
                seriesService.fillDescriptionIfEmpty(target, join.description());
                postRepository.flush();
                return null;
            });
        }
        if (join.part() != null) {
            int part = join.part();
            guarded(position, false, () -> {
                seriesService.placeByPart(target, postId, part);
                postRepository.flush();
                return null;
            });
        }
        return series;
    }

    /**
     * Row locks on the posts the files name by their final slug: the members of their translation groups first, then the posts,
     * each in id order, as the translation service takes them. Reads ids only, so that the posts are read afterwards as they are
     * under the locks.
     */
    private void lockMatchedPosts(List<ParsedPost> chosen) {
        Set<UUID> postIds = new TreeSet<>();
        for (ParsedPost parsed : chosen) {
            String slug = parsed.values().slug();
            if (slug != null) {
                importRepository.findPostIdBySlug(slug).ifPresent(postIds::add);
            }
        }
        Set<UUID> groups = new TreeSet<>();
        for (UUID postId : postIds) {
            UUID group = postRepository.findTranslationGroupId(postId);
            if (group != null) {
                groups.add(group);
            }
        }
        groups.forEach(postRepository::lockTranslationGroup);
        postIds.forEach(postRepository::findByIdForUpdate);
    }

    /**
     * Updates an existing post with the merged values of its file, through the post service as the editor does: the language and
     * the slug are never sent, so they never change. When the text changes, the text it replaces is recorded first as a revision
     * that the ten-minute merging cannot swallow (the update then finds it younger than the window and writes no second one).
     *
     * @return the id of that revision, null when the text does not change
     */
    private UUID updateOne(
            Preview plan,
            Planned one,
            UUID userId,
            Map<String, UUID> createdCategories,
            Map<String, UUID> createdTags,
            String content) {
        int position = one.upload().position();
        Update update = one.update();
        if (!update.postChanges()) {
            // Only the series changes: the post, its revisions and its update time stay as they are.
            return null;
        }
        UUID categoryAfter = update.categoryBefore();
        if (update.categoryName() != null) {
            categoryAfter = guarded(
                    position,
                    false,
                    () -> categoryId(
                            plan,
                            update.categoryName(),
                            update.language(),
                            createdCategories,
                            update.categoryBefore() == null ? Set.of() : Set.of(update.categoryBefore())));
        }
        Set<UUID> tagsAfter = new LinkedHashSet<>(update.tagsBefore());
        if (update.tagNames() != null) {
            tagsAfter = guarded(
                    position,
                    false,
                    () -> tagIds(plan, update.tagNames(), update.language(), createdTags, update.tagsBefore()));
        }
        UUID category = categoryAfter;
        Set<UUID> tags = tagsAfter;
        UUID revisionId = update.textChanges()
                ? guarded(position, false, () -> postRevisionService.recordCurrent(update.postId(), userId))
                : null;
        guarded(position, false, () -> {
            postService.update(
                    update.postId(),
                    new PostUpdateRequest(update.title(), update.excerpt(), content, category, tags, null, null),
                    userId);
            // Write now, so that a violation is attributed to this file and not found at commit.
            postRepository.flush();
            return null;
        });
        return revisionId;
    }

    /**
     * Creates the categories and tags of the file that do not exist yet (once each over the whole apply, in file order), then
     * the post as a draft of the caller. Whatever the services throw becomes one import error with the file position only.
     */
    private PostResponse createOne(
            Preview plan,
            Planned one,
            UUID userId,
            Map<String, UUID> createdCategories,
            Map<String, UUID> createdTags) {
        int position = one.upload().position();
        PostFileValues values = one.parsed().values();
        String language = one.file().language();
        String slug = one.file().slug();
        UUID categoryId = guarded(
                position, false, () -> categoryId(plan, values.category(), language, createdCategories, Set.of()));
        Set<UUID> tagIds = guarded(position, false, () -> tagIds(plan, values.tags(), language, createdTags, Set.of()));
        PostResponse post = guarded(position, true, () -> {
            PostResponse made = postService.create(
                    userId,
                    new PostCreateRequest(
                            values.title(), values.excerpt(), values.content(), categoryId, tagIds, slug, language));
            // Write now, so that a violation is attributed to this file and not found at commit.
            postRepository.flush();
            return made;
        });
        if (!slug.equals(post.slug())) {
            // The planned slug was taken after the plan and the post service numbered it: never keep that.
            throw slugNotAvailable(position);
        }
        return post;
    }

    /**
     * Runs one write. An ApiException or a data-integrity failure is mapped and the original (whose message may hold a name or
     * a constraint) is dropped: a violation while writing the post itself is "slug not available" for the file, anything else
     * means the data changed since the preview. The one exception is a limit on an AUTHOR (posts a day, tags and categories, the
     * rate of creating them): its text is fixed and holds no name, and "the data changed, preview again" would send the author
     * round in circles, because a new preview changes nothing. The limit is passed on as it is, and the import is not committed.
     */
    private <T> T guarded(int position, boolean writesPost, Supplier<T> write) {
        try {
            return write.get();
        } catch (DataIntegrityViolationException e) {
            log.warn("post import write refused position={} postWrite={}", position, writesPost);
            throw writesPost ? slugNotAvailable(position) : dataChanged(position);
        } catch (ApiException e) {
            log.warn("post import write refused code={} position={}", e.getCode(), position);
            if (e.getCode() == ErrorCode.AUTHOR_QUOTA_EXCEEDED || e.getCode() == ErrorCode.RATE_LIMITED) {
                throw e;
            }
            throw dataChanged(position);
        }
    }

    private UUID categoryId(
            Preview plan, String name, String language, Map<String, UUID> created, Collection<UUID> attached) {
        if (name == null) {
            return null;
        }
        Result result = plan.resolveCategory(name, language, attached);
        return switch (result.outcome()) {
            case FOUND -> result.id();
            case MISSING ->
                created.computeIfAbsent(
                        TaxonomyResolver.fold(name),
                        key -> categoryService
                                .create(new CategoryRequest(name, null), plan.userId, plan.admin)
                                .id());
            case AMBIGUOUS -> throw dataChanged(0);
        };
    }

    private Set<UUID> tagIds(
            Preview plan, List<String> names, String language, Map<String, UUID> created, Collection<UUID> attached) {
        Set<UUID> ids = new LinkedHashSet<>();
        for (String name : names) {
            Result result = plan.resolveTag(name, language, attached);
            switch (result.outcome()) {
                case FOUND -> ids.add(result.id());
                case MISSING ->
                    ids.add(created.computeIfAbsent(
                            TaxonomyResolver.fold(name),
                            key -> tagService
                                    .create(new TagRequest(name), plan.userId, plan.admin)
                                    .id()));
                case AMBIGUOUS -> throw dataChanged(0);
            }
        }
        return ids;
    }

    // --- The images of a ZIP package --------------------------------------------------------------------------

    /**
     * Processes the images that the articles of the selected packages use, one after the other (the pipeline allows a few at
     * once and queues the rest), outside any transaction. An image that cannot be used is a problem of its file, named by the
     * entry's position; all of them are collected, so that one answer lists them. A pipeline that stays busy is 503
     * {@code POST_IMPORT_MEDIA_BUSY}. Returns, by position of the file and path of the image, what the transaction stores.
     */
    private Map<Integer, Map<String, PreparedUpload>> prepareImages(
            Map<Integer, PostPackageAnalysis.Result> packages, UUID userId) {
        Map<Integer, Map<String, PreparedUpload>> images = new HashMap<>();
        List<PostImportProblem> problems = new ArrayList<>();
        for (Map.Entry<Integer, PostPackageAnalysis.Result> file : packages.entrySet()) {
            int position = file.getKey();
            Map<String, PreparedUpload> prepared = new LinkedHashMap<>();
            List<PostPackage.Asset> assets = new ArrayList<>();
            file.getValue().used().forEach(used -> assets.add(used.asset()));
            PostPackage.Asset cover = file.getValue().cover();
            if (cover != null && !assets.contains(cover)) {
                assets.add(cover);
            }
            for (PostPackage.Asset asset : assets) {
                if (asset.format() == null) {
                    continue; // not an accepted format: the reader already made it a problem
                }
                try {
                    prepared.put(asset.path(), mediaService.prepare(asset.data(), baseName(asset.path()), userId));
                } catch (ApiException e) {
                    log.warn("post import image refused code={} position={}", e.getCode(), position);
                    if (e.getCode() == ErrorCode.MEDIA_BUSY) {
                        throw new ApiException(
                                ErrorCode.POST_IMPORT_MEDIA_BUSY,
                                HttpStatus.SERVICE_UNAVAILABLE,
                                "File " + position + ", entry " + asset.entry()
                                        + ": another image is being processed; try again in a moment");
                    }
                    problems.add(new PostImportProblem(position, null, null, unusableImage(asset.entry(), e)));
                }
            }
            images.put(position, prepared);
        }
        if (!problems.isEmpty()) {
            throw invalid(problems);
        }
        return images;
    }

    /** Why the image pipeline refused an image, as a fixed sentence about the entry. */
    private static String unusableImage(int entry, ApiException e) {
        return switch (e.getCode()) {
            case MEDIA_UNREADABLE ->
                "entry " + entry + " is an image that could not be read; it may be damaged or truncated";
            case MEDIA_UNSUPPORTED_TYPE -> "entry " + entry + " is not a JPEG, PNG or WebP image";
            case MEDIA_DIMENSIONS_TOO_LARGE -> "entry " + entry + " is an image with too many pixels; make it smaller";
            case MEDIA_TOO_LARGE -> "entry " + entry + " is an image that is too large to store, even after resizing";
            default -> "entry " + entry + " could not be used as an image";
        };
    }

    private static String baseName(String path) {
        return path.substring(path.lastIndexOf('/') + 1);
    }

    /** A new post: stores the images and, when there are any, points the references of its body at them. */
    private void attachImages(
            Planned one,
            UUID postId,
            UUID userId,
            Map<Integer, PostPackageAnalysis.Result> packages,
            Map<Integer, Map<String, PreparedUpload>> images) {
        String content = one.parsed().values().content();
        String rewritten = storeImages(one, postId, content, userId, packages, images);
        if (rewritten.equals(content)) {
            return;
        }
        // Not through the post service: this is still the creation of the post, and a revision of the text without the
        // image paths would only be noise in its history.
        guarded(one.upload().position(), false, () -> {
            postRepository
                    .findById(postId)
                    .orElseThrow(() -> new IllegalStateException("the written post is not readable"))
                    .setContent(rewritten);
            postRepository.flush();
            return null;
        });
    }

    /**
     * Stores the prepared images that the article names as images of the post (which holds its row lock), and returns the body
     * with each reference to one of them replaced by {@code /media/<id>.<ext>#<width>x<height>}. The body itself when the file
     * is not a package or names no image.
     */
    private String storeImages(
            Planned one,
            UUID postId,
            String content,
            UUID userId,
            Map<Integer, PostPackageAnalysis.Result> packages,
            Map<Integer, Map<String, PreparedUpload>> images) {
        int position = one.upload().position();
        PostPackageAnalysis.Result analysis = packages.get(position);
        Map<String, PreparedUpload> prepared = images.get(position);
        if (analysis == null || prepared == null || prepared.isEmpty()) {
            return content;
        }
        Map<Ref, String> replacements = new HashMap<>();
        for (Used used : analysis.used()) {
            PreparedUpload image = prepared.get(used.asset().path());
            if (image == null) {
                continue;
            }
            // The same image already stored for this post (the same package imported again, or two files of equal
            // bytes) is
            // used as it is: an import repeated does not pile up copies.
            Media media = mediaRepository
                    .findFirstByPostIdAndSha256(postId, image.image().sha256())
                    .orElseGet(() ->
                            persistImage(position, used.asset().entry(), image, altText(used.alt()), userId, postId));
            String url = "/media/" + media.fileName() + "#" + media.getWidth() + "x" + media.getHeight();
            used.refs().forEach(ref -> replacements.put(ref, url));
        }
        return PostPackageRefs.rewrite(content, replacements);
    }

    /** One image of the post. A full media quota is its own import error; whatever else the media service says means the data changed. */
    private Media persistImage(int position, int entry, PreparedUpload image, String alt, UUID userId, UUID postId) {
        return storing(position, entry, () -> mediaService.persistForPost(image, alt, userId, postId));
    }

    /**
     * The cover of the package becomes the cover of the post (which holds its row lock), in place of the one it has, the way the
     * editor's upload does it. A file without a usable cover, and a cover that is already the stored one (same processed bytes
     * and, when the file gives a description, the same description) write nothing.
     */
    private void replaceCover(
            Planned one,
            UUID postId,
            UUID userId,
            Map<Integer, PostPackageAnalysis.Result> packages,
            Map<Integer, Map<String, PreparedUpload>> images) {
        int position = one.upload().position();
        PostPackageAnalysis.Result analysis = packages.get(position);
        if (analysis == null || analysis.cover() == null) {
            return;
        }
        PreparedUpload image = images.get(position).get(analysis.cover().path());
        if (image == null) {
            return;
        }
        String alt = altText(one.parsed().values().coverAlt());
        Media current = postRepository
                .findById(postId)
                .orElseThrow(() -> new IllegalStateException("the written post is not readable"))
                .getCover();
        if (current != null
                && current.getSha256().equals(image.image().sha256())
                && (alt == null || alt.equals(current.getAltText()))) {
            return;
        }
        guarded(position, false, () -> {
            postRepository.flush();
            return null;
        });
        storing(position, analysis.cover().entry(), () -> postCoverService.replace(postId, image, alt, userId));
    }

    /** One write of an image: a full media quota is its own import error; whatever else the services say means the data changed. */
    private <T> T storing(int position, int entry, Supplier<T> store) {
        try {
            return store.get();
        } catch (DataIntegrityViolationException e) {
            log.warn("post import image write refused position={}", position);
            throw dataChanged(position);
        } catch (ApiException e) {
            log.warn("post import image refused code={} position={}", e.getCode(), position);
            if (e.getCode() == ErrorCode.MEDIA_QUOTA_EXCEEDED) {
                throw new ApiException(
                        ErrorCode.POST_IMPORT_MEDIA_QUOTA_EXCEEDED,
                        HttpStatus.UNPROCESSABLE_CONTENT,
                        "File " + position + ", entry " + entry
                                + ": the image storage is full; delete some old images and import again");
            }
            throw dataChanged(position);
        }
    }

    /** The description of an image as the author wrote it, cut to what the media table keeps. */
    private static String altText(String alt) {
        if (alt == null) {
            return null;
        }
        String stripped = alt.strip();
        if (stripped.codePointCount(0, stripped.length()) > Media.ALT_TEXT_MAX_LENGTH) {
            stripped = stripped.substring(0, stripped.offsetByCodePoints(0, Media.ALT_TEXT_MAX_LENGTH));
        }
        return stripped.isEmpty() ? null : stripped;
    }

    // --- The article of one file ----------------------------------------------------------------------------

    /**
     * The article of one Markdown file or ZIP package as the person who uploaded it will see it: the body, the images of the
     * package that the body uses (inlined, as uploaded) and the problems of the file, listed like the preview does. Writes and
     * stores nothing. The answer goes only to the caller and may hold the text of the file; no log line does.
     */
    public PostArticlePreviewResponse articlePreview(MultipartFile file, UUID userId) {
        // Its own bucket: the page calls it once per importable file, which must not use up the previews and applies.
        rateLimiter.check(RateLimiter.ARTICLE_PREVIEW, userId);
        Upload upload = PostUploads.read(file == null ? null : List.of(file)).get(0);
        ParsedPost parsed = PostUploads.parse(upload);
        List<PostImportProblem> problems = new ArrayList<>();
        for (ParsedPost.Problem problem : parsed.problems()) {
            problems.add(new PostImportProblem(
                    problem.position(),
                    problem.key() == null ? null : problem.key().keyName(),
                    problem.line(),
                    problem.message()));
        }
        PostPackageFacts facts = null;
        List<PostArticlePreviewResponse.Asset> assets = new ArrayList<>();
        if (upload.pack() != null && !parsed.unreadable()) {
            PostPackageAnalysis.Result analysis = PostPackageAnalysis.of(upload, parsed, true);
            problems.addAll(analysis.problems());
            facts = analysis.facts();
            for (Used used : analysis.used()) {
                PostPackage.Asset asset = used.asset();
                if (asset.format() != null) {
                    int[] size = ImageProcessor.headerSize(asset.data()).orElse(new int[] {0, 0});
                    assets.add(new PostArticlePreviewResponse.Asset(
                            asset.path(),
                            contentType(asset.format()),
                            Base64.getEncoder().encodeToString(asset.data()),
                            size[0],
                            size[1]));
                }
            }
        }
        PostFileValues values = parsed.values();
        List<PostImportProblem> listed = problems.size() > PostFileLimits.MAX_PROBLEMS_PER_RESPONSE
                ? List.copyOf(problems.subList(0, PostFileLimits.MAX_PROBLEMS_PER_RESPONSE))
                : List.copyOf(problems);
        log.info(
                "post import article previewed package={} assets={} problems={} bytes={}",
                upload.pack() != null,
                assets.size(),
                problems.size(),
                upload.bytes());
        return new PostArticlePreviewResponse(
                upload.fileName(),
                values.title(),
                values.excerpt(),
                values.category(),
                values.tags(),
                values.language(),
                values.slug(),
                parsed.unreadable() ? null : values.content(),
                parsed.bodyLine(),
                List.copyOf(assets),
                facts,
                listed,
                problems.size());
    }

    private static String contentType(ImageFormat format) {
        return switch (format) {
            case JPEG -> "image/jpeg";
            case PNG -> "image/png";
            case WEBP -> "image/webp";
        };
    }

    // --- Status --------------------------------------------------------------------------------------------

    /** The caller's own newest import, never anybody else's. */
    @Transactional(readOnly = true)
    public PostImportStatusResponse status(UUID userId) {
        return new PostImportStatusResponse(
                importRepository.findLatestOf(userId).map(this::lastImport).orElse(null));
    }

    /** {@code undoable} is false until the undo exists. */
    private LastPostImport lastImport(LogRow row) {
        int created = 0;
        int updated = 0;
        try {
            for (JsonNode item : objectMapper.readTree(row.items())) {
                String action = item.path("action").asString();
                if (ACTION_CREATED.equals(action)) {
                    created++;
                } else if (ACTION_UPDATED.equals(action)) {
                    updated++;
                }
            }
        } catch (JacksonException e) {
            log.warn("post import log row {} has unreadable items", row.id());
        }
        return new LastPostImport(row.id(), row.createdAt(), row.fileCount(), created, updated, row.undone(), false);
    }

    // --- Errors --------------------------------------------------------------------------------------------

    /** 400 {@code POST_IMPORT_INVALID}: positions, keys, line numbers and fixed sentences only. */
    private static ApiException invalid(List<PostImportProblem> problems) {
        List<String> parts = new ArrayList<>();
        for (PostImportProblem problem :
                problems.stream().limit(MAX_MESSAGE_PROBLEMS).toList()) {
            StringBuilder part = new StringBuilder("File ").append(problem.position());
            if (problem.line() != null) {
                part.append(" line ").append(problem.line());
            }
            if (problem.key() != null) {
                part.append(' ').append(problem.key());
            }
            parts.add(part.append(": ").append(problem.message()).toString());
        }
        String message = String.join("; ", parts);
        if (problems.size() > MAX_MESSAGE_PROBLEMS) {
            message += "; and " + (problems.size() - MAX_MESSAGE_PROBLEMS) + " more";
        }
        return new ApiException(ErrorCode.POST_IMPORT_INVALID, HttpStatus.BAD_REQUEST, message);
    }

    private static ApiException slugNotAvailable(int position) {
        return invalid(List.of(new PostImportProblem(position, PostKey.SLUG.keyName(), null, SLUG_NOT_AVAILABLE)));
    }

    /** 409 {@code POST_IMPORT_PREVIEW_OUT_OF_DATE} for a write that failed because the data is not what the plan read. */
    private static ApiException dataChanged(int position) {
        return new ApiException(
                ErrorCode.POST_IMPORT_PREVIEW_OUT_OF_DATE,
                HttpStatus.CONFLICT,
                position > 0
                        ? "File " + position + " could not be written because the data changed; preview again"
                        : "The data changed; preview again");
    }

    // --- The answer ----------------------------------------------------------------------------------------

    /** Lists at most {@link PostFileLimits#MAX_PROBLEMS_PER_RESPONSE} problems, but always the first one of a file in error. */
    private static PostPreviewResponse response(
            List<PostPreviewFile> files, int newCategories, int newTags, int newSeries, int totalBytes) {
        int budget = PostFileLimits.MAX_PROBLEMS_PER_RESPONSE;
        int omitted = 0;
        List<PostPreviewFile> capped = new ArrayList<>();
        List<Integer> withProblems = new ArrayList<>();
        for (PostPreviewFile file : files) {
            int listed = Math.min(
                    file.problems().size(), Math.max(budget, file.problems().isEmpty() ? 0 : 1));
            budget = Math.max(0, budget - listed);
            omitted += file.problemsTotal() - listed;
            capped.add(listed == file.problems().size() ? file : withListedProblems(file, listed));
            if (PostPreviewFile.ERROR.equals(file.state())) {
                withProblems.add(file.position());
            }
        }
        return new PostPreviewResponse(
                List.copyOf(capped), List.copyOf(withProblems), omitted, newCategories, newTags, newSeries, totalBytes);
    }

    private static PostPreviewFile withListedProblems(PostPreviewFile file, int listed) {
        return new PostPreviewFile(
                file.position(),
                file.fileName(),
                file.bytes(),
                file.sha256(),
                file.slug(),
                file.slugSource(),
                file.language(),
                file.state(),
                file.changes(),
                file.notes(),
                file.newCategories(),
                file.newTags(),
                file.newSeries(),
                List.copyOf(file.problems().subList(0, listed)),
                file.problemsTotal(),
                file.ignored(),
                file.ignoredTotal(),
                file.previewState(),
                file.pkg());
    }

    private static String cut(String value) {
        if (value == null) {
            return null;
        }
        int max = PostFileLimits.MAX_CHANGE_TEXT_CHARS;
        if (value.length() <= max) {
            return value;
        }
        int end = Character.isHighSurrogate(value.charAt(max - 1)) ? max - 1 : max;
        return value.substring(0, end);
    }

    private static String slugSource(SlugSource source) {
        return source == null || source == SlugSource.KEY ? null : source.name().toLowerCase(Locale.ROOT);
    }

    private static String positions(List<Integer> positions) {
        return String.join(", ", positions.stream().map(String::valueOf).toList());
    }

    // --- One preview ---------------------------------------------------------------------------------------

    /** The state of one preview: who asks, what the site has, and the names the files before this one would create. */
    private final class Preview {

        private final UUID userId;
        private final boolean admin;
        private final String defaultLanguage;
        private final List<Entry> categories;
        private final List<Entry> tags;
        /** Final slug to the positions of the files that have it, for the slugs that more than one file has. */
        private final Map<String, List<Integer>> sharedSlugs = new LinkedHashMap<>();
        /** Names the files so far would create, once each, by their compared form. */
        private final Map<String, String> createdCategories = new LinkedHashMap<>();

        private final Map<String, String> createdTags = new LinkedHashMap<>();
        /** Series the files so far would create, once each, by the key of their name (see {@link SeriesJoin#creationKey}). */
        private final Map<String, String> createdSeries = new LinkedHashMap<>();
        /** The series, language and part the files so far give, to the position of the first file that gave it. */
        private final Map<String, Integer> claimedParts = new HashMap<>();
        /** The series list of this preview, read when the first file with a series needs it. */
        private List<SeriesResolver.Entry> seriesEntries;
        /** The series of that list that have no description. */
        private final Set<UUID> seriesWithoutDescription = new HashSet<>();
        /** The series, as {@code id:...} or by creation key, that a file so far gives a description (the first one to do so). */
        private final Set<String> describedSeries = new HashSet<>();

        Preview(UUID userId, boolean admin, List<ParsedPost> parsed) {
            this.userId = userId;
            this.admin = admin;
            this.defaultLanguage = languages.defaultLocale();
            this.categories = categoryService.list().stream()
                    .map(category -> new Entry(category.id(), category.name(), category.translations()))
                    .toList();
            this.tags = tagService.list().stream()
                    .map(tag -> new Entry(tag.id(), tag.name(), tag.translations()))
                    .toList();
            Map<String, List<Integer>> bySlug = new LinkedHashMap<>();
            for (ParsedPost file : parsed) {
                String slug = file.values().slug();
                if (slug != null) {
                    bySlug.computeIfAbsent(slug, key -> new ArrayList<>()).add(file.position());
                }
            }
            bySlug.forEach((slug, positions) -> {
                if (positions.size() > 1) {
                    sharedSlugs.put(slug, positions);
                }
            });
        }

        /** What the preview decided for each file that matches a post the caller may manage and has no problem, by position. */
        final Map<Integer, Update> updates = new HashMap<>();

        /** The series each file without a problem joins, by position: what the apply writes after the post. */
        final Map<Integer, SeriesJoin> joins = new HashMap<>();

        /** The slug of a file against the posts: the one the caller may manage, and whether any post has it. */
        private record Match(Post post, boolean taken) {}

        Result resolveCategory(String name, String language, Collection<UUID> attached) {
            return TaxonomyResolver.resolveAttached(name, language, categories, attached, PostNormalForm::line);
        }

        Result resolveTag(String name, String language, Collection<UUID> attached) {
            return TaxonomyResolver.resolveAttached(name, language, tags, attached, PostNormalForm::tag);
        }

        PostPreviewFile file(Upload upload, ParsedPost parsed) {
            if (parsed.unreadable()) {
                return unreadable(upload, parsed);
            }
            PostFileValues values = parsed.values();
            Problems problems = new Problems(parsed);
            List<PostImportNote> notes = new ArrayList<>();
            PostPackageFacts facts = null;
            boolean storesImages = false;
            PostPackage.Asset cover = null;
            if (upload.pack() != null) {
                // The images and the unsafe content of a ZIP package; the article itself is judged like any post file.
                PostPackageAnalysis.Result analysis = PostPackageAnalysis.of(upload, parsed, true);
                analysis.problems()
                        .forEach(problem -> problems.add(
                                problem.key() == null ? null : PostKey.byName(problem.key()),
                                problem.line(),
                                problem.message()));
                notes.addAll(analysis.notes());
                facts = analysis.facts();
                storesImages = !analysis.used().isEmpty();
                cover = analysis.cover();
            } else if (values.cover() != null) {
                problems.add(
                        PostKey.COVER,
                        parsed.lines().get(PostKey.COVER),
                        "a cover image needs a ZIP package; a plain Markdown file cannot carry one");
            }

            Match match = checkSlug(parsed, problems);
            Post target = match.post();
            if (parsed.slugSource() == SlugSource.FILE_NAME) {
                notes.add(new PostImportNote(PostImportNote.SLUG_FROM_FILE_NAME, null, null));
            } else if (parsed.slugSource() == SlugSource.TITLE) {
                notes.add(new PostImportNote(PostImportNote.SLUG_FROM_TITLE, null, null));
            }
            if (!match.taken()) {
                newPostNeeds(parsed, problems);
            }

            String language = language(parsed, problems, notes, target);
            List<String> newCategories = new ArrayList<>();
            List<String> newTags = new ArrayList<>();
            List<String> newSeries = new ArrayList<>();
            int tagCount = 0;
            Update update = null;
            SeriesStep step = target != null || !match.taken()
                    ? series(parsed, target, language, problems, notes)
                    : SeriesStep.NONE;
            if (target != null) {
                update =
                        existing(parsed, target, language, storesImages, cover, problems, newCategories, newTags, step);
                checkCaps(parsed, problems, newCategories, newTags);
            } else if (!match.taken()) {
                String resolveIn = language == null ? defaultLanguage : language;
                categoryOf(parsed, resolveIn, problems, newCategories);
                tagCount = tagsOf(parsed, resolveIn, problems, newTags);
                tagLimit(parsed, tagCount, problems);
                checkCaps(parsed, problems, newCategories, newTags);
            }
            if (problems.total == 0) {
                register(newCategories, createdCategories);
                register(newTags, createdTags);
                if (step.createKey() != null) {
                    createdSeries.put(step.createKey(), step.join().name());
                    newSeries.add(step.join().name());
                    notes.add(new PostImportNote(
                            PostImportNote.SERIES_WILL_BE_CREATED,
                            PostKey.SERIES.keyName(),
                            parsed.lines().get(PostKey.SERIES)));
                }
                if (step.claimKey() != null) {
                    claimedParts.put(step.claimKey(), parsed.position());
                }
                if (step.describeKey() != null) {
                    describedSeries.add(step.describeKey());
                }
                if (step.join() != null) {
                    joins.put(parsed.position(), step.join());
                }
                if (!newCategories.isEmpty()) {
                    notes.add(new PostImportNote(
                            PostImportNote.CATEGORY_WILL_BE_CREATED,
                            PostKey.CATEGORY.keyName(),
                            parsed.lines().get(PostKey.CATEGORY)));
                }
                if (!newTags.isEmpty()) {
                    notes.add(new PostImportNote(
                            PostImportNote.TAGS_WILL_BE_CREATED,
                            PostKey.TAGS.keyName(),
                            parsed.lines().get(PostKey.TAGS)));
                }
                if (cover != null && (target == null || update.coverChanges())) {
                    notes.add(new PostImportNote(
                            target != null && update.coverReplaces()
                                    ? PostImportNote.COVER_WILL_BE_REPLACED
                                    : PostImportNote.COVER_WILL_BE_SET,
                            PostKey.COVER.keyName(),
                            parsed.lines().get(PostKey.COVER)));
                }
                // A note, never a problem: the draft is imported and the state is untouched, but it cannot be published
                // as it is.
                if (values.category() == null && (target == null ? !match.taken() : target.getCategory() == null)) {
                    notes.add(new PostImportNote(
                            PostImportNote.CATEGORY_MISSING,
                            PostKey.CATEGORY.keyName(),
                            parsed.lines().get(PostKey.CATEGORY)));
                }
            } else {
                // A file with a problem is not imported, so it creates nothing and its names count nowhere.
                newCategories.clear();
                newTags.clear();
            }
            if (target != null || !match.taken()) {
                ignoredNotes(parsed, notes, target);
            }
            ignoredKeys(parsed, notes);

            boolean error = problems.total > 0;
            String state;
            if (error) {
                state = PostPreviewFile.ERROR;
            } else if (target == null) {
                state = PostPreviewFile.NEW;
            } else {
                state = update.differs() ? PostPreviewFile.WILL_CHANGE : PostPreviewFile.UNCHANGED;
                updates.put(parsed.position(), update);
                if (update.differs() && PostStatus.PUBLISHED.name().equals(update.status())) {
                    notes.add(new PostImportNote(PostImportNote.PUBLISHED_GOES_LIVE, null, null));
                }
            }
            String previewState = null;
            if (PostPreviewFile.NEW.equals(state)) {
                previewState = PreviewState.forNew(
                                step.join() == null ? null : step.join().stateHash())
                        .encode();
            } else if (PostPreviewFile.WILL_CHANGE.equals(state)) {
                previewState = update.previewState();
            }
            PostPreviewChanges changes = null;
            if (!error) {
                changes = target == null ? newPostChanges(values, tagCount, step) : update.changes();
            }
            return new PostPreviewFile(
                    parsed.position(),
                    upload.fileName(),
                    upload.bytes(),
                    upload.sha256(),
                    values.slug(),
                    slugSource(parsed.slugSource()),
                    language,
                    state,
                    changes,
                    List.copyOf(notes),
                    List.copyOf(newCategories),
                    List.copyOf(newTags),
                    List.copyOf(newSeries),
                    List.copyOf(problems.listed),
                    problems.total,
                    parsed.ignored(),
                    parsed.ignoredTotal(),
                    previewState,
                    facts);
        }

        /**
         * A file whose front matter could not be read has no content to judge: it reports the parser's one problem and nothing
         * that depends on its content (a new post's needs, language, category, tags, slug, notes), which would only be wrong.
         */
        private PostPreviewFile unreadable(Upload upload, ParsedPost parsed) {
            Problems problems = new Problems(parsed);
            return new PostPreviewFile(
                    parsed.position(),
                    upload.fileName(),
                    upload.bytes(),
                    upload.sha256(),
                    parsed.values().slug(),
                    slugSource(parsed.slugSource()),
                    null,
                    PostPreviewFile.ERROR,
                    null,
                    List.of(),
                    List.of(),
                    List.of(),
                    List.of(),
                    List.copyOf(problems.listed),
                    problems.total,
                    parsed.ignored(),
                    parsed.ignoredTotal(),
                    null,
                    null);
        }

        /**
         * Compares what the file supplies with the stored post, in the normal form the download writes on both sides: a value that
         * is missing, empty or equal keeps the stored one (so a short file never clears anything), and the post is unchanged when
         * every supplied value is equal. Category and tags that the file names and that do not exist yet count as a change.
         * A package that uses images always counts its body as a change and writes the text of the file: the stored images and the
         * references that point at them exist only through that write, even when the stored body already reads the same.
         * The cover of a package is a change when the post has none, or has one that differs (other bytes, or another description
         * when the file gives one): the package wins, the stored cover is replaced.
         */
        private Update existing(
                ParsedPost parsed,
                Post target,
                String language,
                boolean storesImages,
                PostPackage.Asset cover,
                Problems problems,
                List<String> newCategories,
                List<String> newTags,
                SeriesStep step) {
            PostFileValues values = parsed.values();
            UUID categoryBefore =
                    target.getCategory() == null ? null : target.getCategory().getId();
            List<UUID> tagsBefore =
                    target.getTags().stream().map(Tag::getId).sorted().toList();

            boolean sameTitle = values.title() == null
                    || PostNormalForm.line(values.title()).equals(PostNormalForm.line(target.getTitle()));
            boolean sameExcerpt = values.excerpt() == null
                    || PostNormalForm.line(values.excerpt()).equals(PostNormalForm.line(target.getExcerpt()));
            boolean sameContent = !storesImages
                    && (values.content().isBlank()
                            || PostNormalForm.content(values.content())
                                    .equals(PostNormalForm.content(target.getContent())));
            String title = sameTitle ? target.getTitle() : values.title();
            String excerpt = sameExcerpt ? target.getExcerpt() : values.excerpt();
            String content = sameContent ? target.getContent() : values.content();

            String categoryBeforeName =
                    target.getCategory() == null ? null : target.getCategory().getName();
            String categoryName = null;
            if (values.category() != null) {
                Result result = resolveCategory(
                        values.category(), language, categoryBefore == null ? Set.of() : Set.of(categoryBefore));
                switch (result.outcome()) {
                    case AMBIGUOUS ->
                        problems.add(
                                PostKey.CATEGORY,
                                parsed.lines().get(PostKey.CATEGORY),
                                "more than one category has this name");
                    case MISSING -> {
                        categoryName = values.category();
                        if (!createdCategories.containsKey(TaxonomyResolver.fold(categoryName))) {
                            newCategories.add(categoryName);
                        }
                    }
                    case FOUND -> {
                        if (!result.id().equals(categoryBefore)) {
                            categoryName = values.category();
                        }
                    }
                }
            }

            List<String> tagNames = null;
            int tagsKept = tagsBefore.size();
            int tagsAdded = 0;
            int tagsRemoved = 0;
            if (!values.tags().isEmpty()) {
                Set<UUID> wanted = new LinkedHashSet<>();
                Set<String> seen = new LinkedHashSet<>();
                int missing = 0;
                boolean ambiguous = false;
                for (String name : values.tags()) {
                    String folded = TaxonomyResolver.fold(name);
                    if (!seen.add(folded)) {
                        continue;
                    }
                    Result result = resolveTag(name, language, tagsBefore);
                    switch (result.outcome()) {
                        case FOUND -> wanted.add(result.id());
                        case AMBIGUOUS -> ambiguous = true;
                        case MISSING -> {
                            missing++;
                            if (!createdTags.containsKey(folded)) {
                                newTags.add(name);
                            }
                        }
                    }
                }
                if (ambiguous) {
                    problems.add(
                            PostKey.TAGS,
                            parsed.lines().get(PostKey.TAGS),
                            "more than one tag has the name of at least one of the tags");
                } else if (missing > 0 || !wanted.equals(new LinkedHashSet<>(tagsBefore))) {
                    // The rule of PostService.requireTagCount, so that the apply never fails on it: over the limit, and
                    // not a subset of
                    // the tags the post has now.
                    if (missing > 0 || !tagsBefore.containsAll(wanted)) {
                        tagLimit(parsed, wanted.size() + missing, problems);
                    }
                    tagNames = values.tags();
                    tagsKept =
                            (int) tagsBefore.stream().filter(wanted::contains).count();
                    tagsAdded = wanted.size() - tagsKept + missing;
                    tagsRemoved = tagsBefore.size() - tagsKept;
                }
            }

            boolean textChanges = !sameTitle || !sameExcerpt || !sameContent;
            boolean postChanges = textChanges || categoryName != null || tagNames != null;
            boolean coverChanges = false;
            boolean coverReplaces = false;
            if (cover != null) {
                Media stored = target.getCover();
                if (stored == null) {
                    coverChanges = true;
                } else {
                    String alt = altText(values.coverAlt());
                    boolean sameBytes = PostFile.sha256Hex(cover.data()).equals(stored.getSha256());
                    boolean sameAlt = alt == null || alt.equals(stored.getAltText());
                    coverChanges = !sameBytes || !sameAlt;
                    coverReplaces = coverChanges;
                }
            }
            boolean differs = postChanges || step.join() != null || coverChanges;
            PostPreviewChanges changes = new PostPreviewChanges(
                    new Change(cut(target.getTitle()), cut(title)),
                    new Change(cut(target.getExcerpt()), cut(excerpt)),
                    new Change(cut(categoryBeforeName), cut(categoryName == null ? categoryBeforeName : categoryName)),
                    tagsAdded,
                    tagsRemoved,
                    tagsKept,
                    !sameContent,
                    false,
                    step.change(),
                    step.partChange());
            return new Update(
                    target.getId(),
                    target.getSlug(),
                    target.getStatus().name(),
                    target.getLanguage(),
                    PostStateHash.of(target),
                    categoryBefore,
                    tagsBefore,
                    title,
                    excerpt,
                    content,
                    categoryName,
                    tagNames,
                    textChanges,
                    postChanges,
                    differs,
                    changes,
                    step.join(),
                    target.getSeries() == null ? null : target.getSeries().getId(),
                    target.getSeriesPosition(),
                    target.getSeriesPart(),
                    coverChanges,
                    coverReplaces);
        }

        /**
         * What a file does with a series. {@code createKey}, {@code claimKey} and {@code describeKey} (the series the file gives a
         * description) are registered once the file has no problem.
         */
        private record SeriesStep(
                SeriesJoin join,
                Change change,
                PartChange partChange,
                String createKey,
                String claimKey,
                String describeKey) {
            static final SeriesStep NONE = new SeriesStep(null, null, null, null, null, null);
        }

        private List<SeriesResolver.Entry> seriesEntries() {
            if (seriesEntries == null) {
                List<Series> rows = seriesRepository.findAllByOrderByTitleAsc();
                seriesEntries =
                        rows.stream().map(PostImportService::seriesEntry).toList();
                rows.stream()
                        .filter(row -> row.getDescription() == null
                                || row.getDescription().isBlank())
                        .forEach(row -> seriesWithoutDescription.add(row.getId()));
            }
            return seriesEntries;
        }

        /**
         * The description the file sets, null when it sets none. A description the file gives is either set (the series has
         * none and no earlier file gives one) or ignored; the note says which. A file without a description says nothing.
         */
        private String describing(ParsedPost parsed, boolean mayBeSet, List<PostImportNote> notes) {
            String description = parsed.values().seriesDescription();
            if (description == null) {
                return null;
            }
            notes.add(new PostImportNote(
                    mayBeSet
                            ? PostImportNote.SERIES_DESCRIPTION_WILL_BE_SET
                            : PostImportNote.SERIES_DESCRIPTION_IGNORED,
                    PostKey.SERIES_DESCRIPTION.keyName(),
                    parsed.lines().get(PostKey.SERIES_DESCRIPTION)));
            return mayBeSet ? description : null;
        }

        /**
         * The series keys of a file. Nothing is read for an author: the keys were checked by the parser, the note says they are
         * not used, and no series is looked up, so the answer cannot tell an author which series exist. For an administrator
         * the name is resolved ({@link SeriesResolver}): the series the post is in, else the series with that slug or title,
         * else a series to create. A file never takes a post out of a series: a name without a part keeps the place of a post
         * that is already a member and is a problem for any other.
         */
        private SeriesStep series(
                ParsedPost parsed, Post target, String language, Problems problems, List<PostImportNote> notes) {
            PostFileValues values = parsed.values();
            String name = values.series();
            if (name == null && values.seriesDescription() == null) {
                return SeriesStep.NONE;
            }
            if (!admin) {
                PostKey key = name != null ? PostKey.SERIES : PostKey.SERIES_DESCRIPTION;
                notes.add(new PostImportNote(
                        PostImportNote.SERIES_IGNORED_AUTHOR,
                        key.keyName(),
                        parsed.lines().get(key)));
                return SeriesStep.NONE;
            }
            if (name == null) {
                notes.add(new PostImportNote(
                        PostImportNote.SERIES_DESCRIPTION_IGNORED,
                        PostKey.SERIES_DESCRIPTION.keyName(),
                        parsed.lines().get(PostKey.SERIES_DESCRIPTION)));
                return SeriesStep.NONE;
            }
            if (language == null) {
                return SeriesStep.NONE;
            }
            Integer line = parsed.lines().get(PostKey.SERIES);
            Integer part = values.seriesPart();
            // A part that is written but is not a number from 1 to the limit is already a problem of the file (the
            // parser reports
            // it): saying "series needs series_part" as well would send the author to add a line that is already there.
            boolean partInvalid = parsed.problems().stream().anyMatch(problem -> problem.key() == PostKey.SERIES_PART);
            UUID attached = target == null || target.getSeries() == null
                    ? null
                    : target.getSeries().getId();
            Integer partBefore = target == null ? null : target.getSeriesPart();
            List<SeriesResolver.Entry> entries = seriesEntries();
            Result result = SeriesResolver.resolve(name, attached, entries);
            Change change = new Change(null, name);
            String claimKey = null;
            String createKey = null;
            String description = null;
            String describeKey = null;
            UUID seriesId = result.id();
            switch (result.outcome()) {
                case AMBIGUOUS -> {
                    problems.add(PostKey.SERIES, line, "more than one series has this name");
                    return SeriesStep.NONE;
                }
                case FOUND -> {
                    SeriesResolver.Entry entry = entries.stream()
                            .filter(candidate -> candidate.id().equals(seriesId))
                            .findFirst()
                            .orElseThrow();
                    if (!SeriesResolver.isTitleOf(name, entry)) {
                        notes.add(new PostImportNote(
                                PostImportNote.SERIES_TITLE_DIFFERS, PostKey.SERIES.keyName(), line));
                    }
                    String key = "id:" + seriesId;
                    description = describing(
                            parsed,
                            seriesWithoutDescription.contains(seriesId) && !describedSeries.contains(key),
                            notes);
                    describeKey = description == null ? null : key;
                    if (part == null) {
                        if (!seriesId.equals(attached)) {
                            if (!partInvalid) {
                                problems.add(PostKey.SERIES, line, "series needs series_part");
                            }
                            return SeriesStep.NONE;
                        }
                        return keepsPlace(seriesId, name, description, describeKey);
                    }
                    if (seriesId.equals(attached) && part.equals(partBefore)) {
                        return keepsPlace(seriesId, name, description, describeKey);
                    }
                    for (UUID holder : postRepository.findSeriesPartHolders(seriesId, language, part)) {
                        if (target == null || !holder.equals(target.getId())) {
                            problems.add(
                                    PostKey.SERIES_PART,
                                    parsed.lines().get(PostKey.SERIES_PART),
                                    "part " + part + " of this series is already used by another post");
                            break;
                        }
                    }
                    claimKey = "id:" + seriesId + "|" + language + "|" + part;
                    change = new Change(attached == null ? null : titleOf(entries, attached), entry.title());
                }
                case MISSING -> {
                    SeriesJoin probe = new SeriesJoin(null, name, null, part == null ? 1 : part);
                    String key = probe.creationKey();
                    boolean announced = createdSeries.containsKey(key);
                    if (part == null) {
                        if (!partInvalid) {
                            problems.add(PostKey.SERIES, line, "series needs series_part");
                        }
                        return SeriesStep.NONE;
                    }
                    if (announced) {
                        description = describing(parsed, !describedSeries.contains(key), notes);
                    } else {
                        createKey = key;
                        description = values.seriesDescription();
                        if (problems.total == 0 && createdSeries.size() >= PostFileLimits.MAX_NEW_SERIES) {
                            problems.add(
                                    PostKey.SERIES,
                                    line,
                                    "this import would create more than " + PostFileLimits.MAX_NEW_SERIES
                                            + " new series");
                        }
                    }
                    describeKey = description == null ? null : key;
                    claimKey = key + "|" + language + "|" + part;
                    change = new Change(attached == null ? null : titleOf(entries, attached), name);
                }
            }
            Integer other = claimedParts.get(claimKey);
            if (other != null) {
                problems.add(
                        PostKey.SERIES_PART,
                        parsed.lines().get(PostKey.SERIES_PART),
                        "part " + part + " of this series is also given by file " + other);
            }
            SeriesJoin join = new SeriesJoin(
                    result.outcome() == TaxonomyResolver.Outcome.FOUND ? seriesId : null, name, description, part);
            return new SeriesStep(
                    join,
                    new Change(cut(change.before()), cut(change.after())),
                    new PartChange(partBefore, part),
                    createKey,
                    claimKey,
                    describeKey);
        }

        /**
         * A post that keeps its place in the series: the file changes nothing about the membership. Only a description it gives
         * to a series that has none is a change; otherwise the file does nothing with the series.
         */
        private static SeriesStep keepsPlace(UUID seriesId, String name, String description, String describeKey) {
            if (description == null) {
                return SeriesStep.NONE;
            }
            return new SeriesStep(
                    new SeriesJoin(seriesId, name, description, null), null, null, null, null, describeKey);
        }

        private static String titleOf(List<SeriesResolver.Entry> entries, UUID id) {
            return entries.stream()
                    .filter(entry -> entry.id().equals(id))
                    .map(SeriesResolver.Entry::title)
                    .findFirst()
                    .orElse(null);
        }

        /**
         * Matches the final slug against the current slugs of posts and adds the slug problems: another file with it, a post of
         * someone else (the same sentence as for an old slug, and nothing else about that post is read), an old slug of any
         * post.
         */
        private Match checkSlug(ParsedPost parsed, Problems problems) {
            String slug = parsed.values().slug();
            if (slug == null) {
                return new Match(null, false);
            }
            Integer line = parsed.lines().get(PostKey.SLUG);
            List<Integer> sharing = sharedSlugs.get(slug);
            if (sharing != null) {
                List<Integer> others =
                        sharing.stream().filter(p -> p != parsed.position()).toList();
                problems.add(
                        PostKey.SLUG,
                        line,
                        "two files use the same slug as " + (others.size() == 1 ? "file " : "files ")
                                + positions(others));
            }
            Optional<Post> current = postRepository.findBySlug(slug);
            if (current.isPresent()) {
                // Only the author's id is read, never anything else of a post the caller may not manage.
                // A post its author deleted (V49) is hidden: it is no longer theirs to update, and its slug stays
                // reserved.
                boolean mine = admin
                        || (current.get().getDeletedAt() == null
                                && userId.equals(current.get().getAuthor().getId()));
                if (!mine) {
                    problems.add(PostKey.SLUG, line, SLUG_NOT_AVAILABLE);
                    return new Match(null, true);
                }
                return new Match(current.get(), true);
            }
            if (postRepository.existsInSlugHistory(slug)) {
                problems.add(PostKey.SLUG, line, SLUG_NOT_AVAILABLE);
            }
            return new Match(null, false);
        }

        /** The editor's rules for a new post: a title that is not blank and a body that is not blank. */
        private void newPostNeeds(ParsedPost parsed, Problems problems) {
            PostFileValues values = parsed.values();
            if (values.title() == null && !problems.has(PostKey.TITLE)) {
                problems.add(PostKey.TITLE, parsed.lines().get(PostKey.TITLE), "a new post needs a title");
            }
            if (values.content().isBlank()) {
                problems.add(null, null, "a new post needs a body");
            }
        }

        /**
         * The language of the post, null when the file's is not enabled. A new post without one takes the site default, with a
         * note. An existing post keeps its language: the file may omit it or repeat it, a different one is a problem.
         */
        private String language(ParsedPost parsed, Problems problems, List<PostImportNote> notes, Post target) {
            String wanted = parsed.values().language();
            Integer line = parsed.lines().get(PostKey.LANGUAGE);
            if (wanted == null) {
                if (target != null) {
                    return target.getLanguage();
                }
                if (!problems.has(PostKey.LANGUAGE)) {
                    notes.add(new PostImportNote(PostImportNote.LANGUAGE_DEFAULTED, PostKey.LANGUAGE.keyName(), line));
                }
                return defaultLanguage;
            }
            String enabled;
            try {
                enabled = languages.require(wanted);
            } catch (ApiException e) {
                problems.add(PostKey.LANGUAGE, line, "the language is not enabled on this site");
                return target == null ? null : target.getLanguage();
            }
            if (target != null && !enabled.equals(target.getLanguage())) {
                problems.add(PostKey.LANGUAGE, line, "an import never changes the language of an existing post");
                return target.getLanguage();
            }
            return enabled;
        }

        private void categoryOf(ParsedPost parsed, String language, Problems problems, List<String> newCategories) {
            String name = parsed.values().category();
            if (name == null) {
                return;
            }
            Result result = TaxonomyResolver.resolve(name, language, categories);
            switch (result.outcome()) {
                case AMBIGUOUS ->
                    problems.add(
                            PostKey.CATEGORY,
                            parsed.lines().get(PostKey.CATEGORY),
                            "more than one category has this name");
                case MISSING -> {
                    if (!createdCategories.containsKey(TaxonomyResolver.fold(name))) {
                        newCategories.add(name);
                    }
                }
                case FOUND -> {}
            }
        }

        /** Returns how many different tags the file names. */
        private int tagsOf(ParsedPost parsed, String language, Problems problems, List<String> newTags) {
            Set<String> seen = new LinkedHashSet<>();
            boolean ambiguous = false;
            for (String name : parsed.values().tags()) {
                String folded = TaxonomyResolver.fold(name);
                if (!seen.add(folded)) {
                    continue;
                }
                Result result = TaxonomyResolver.resolve(name, language, tags);
                if (result.outcome() == TaxonomyResolver.Outcome.AMBIGUOUS) {
                    ambiguous = true;
                } else if (result.outcome() == TaxonomyResolver.Outcome.MISSING && !createdTags.containsKey(folded)) {
                    newTags.add(name);
                }
            }
            if (ambiguous) {
                problems.add(
                        PostKey.TAGS,
                        parsed.lines().get(PostKey.TAGS),
                        "more than one tag has the name of at least one of the tags");
            }
            return seen.size();
        }

        /**
         * An AUTHOR's post carries at most {@code app.author-quota.max-tags-per-post} tags (an ADMIN's is not limited). The apply
         * refuses more with the same rule, and an apply that fails after an accepted preview reads as "the data changed, preview
         * again", a loop for the author: so the preview says it, as a problem of the file, with a sentence that holds no value of it.
         *
         * @param count how many different tags the post would have after the import
         */
        private void tagLimit(ParsedPost parsed, int count, Problems problems) {
            if (!admin && count > authorQuota.maxTagsPerPost()) {
                problems.add(
                        PostKey.TAGS,
                        parsed.lines().get(PostKey.TAGS),
                        "an author can add at most " + authorQuota.maxTagsPerPost() + " tags to a post");
            }
        }

        /** An import creates at most 20 new categories and 50 new tags; the file that goes over is the one with the problem. */
        private void checkCaps(ParsedPost parsed, Problems problems, List<String> newCategories, List<String> newTags) {
            if (problems.total > 0) {
                return;
            }
            if (createdCategories.size() + newCategories.size() > PostFileLimits.MAX_NEW_CATEGORIES) {
                problems.add(
                        PostKey.CATEGORY,
                        parsed.lines().get(PostKey.CATEGORY),
                        "this import would create more than " + PostFileLimits.MAX_NEW_CATEGORIES + " new categories");
            }
            if (createdTags.size() + newTags.size() > PostFileLimits.MAX_NEW_TAGS) {
                problems.add(
                        PostKey.TAGS,
                        parsed.lines().get(PostKey.TAGS),
                        "this import would create more than " + PostFileLimits.MAX_NEW_TAGS + " new tags");
            }
        }

        private static void register(List<String> names, Map<String, String> created) {
            names.forEach(name -> created.put(TaxonomyResolver.fold(name), name));
        }

        /**
         * {@code featured} and {@code status} are parsed and never written. A note only when the file differs from what the post
         * is (or will be, for a new post: not featured, a draft), so an unedited downloaded file shows none. {@code translation_of}
         * is a known key that this import does not use either: a note whenever the file gives one.
         */
        private void ignoredNotes(ParsedPost parsed, List<PostImportNote> notes, Post target) {
            PostFileValues values = parsed.values();
            boolean featured = target != null && target.isFeatured();
            if (values.featured() != null && values.featured() != featured) {
                notes.add(new PostImportNote(
                        PostImportNote.FEATURED_IGNORED,
                        PostKey.FEATURED.keyName(),
                        parsed.lines().get(PostKey.FEATURED)));
            }
            String status = target == null ? DRAFT : target.getStatus().name();
            if (values.status() != null && !values.status().equalsIgnoreCase(status)) {
                notes.add(new PostImportNote(
                        PostImportNote.STATUS_IGNORED,
                        PostKey.STATUS.keyName(),
                        parsed.lines().get(PostKey.STATUS)));
            }
            if (values.translationOf() != null) {
                notes.add(new PostImportNote(
                        PostImportNote.TRANSLATION_OF_IGNORED,
                        PostKey.TRANSLATION_OF.keyName(),
                        parsed.lines().get(PostKey.TRANSLATION_OF)));
            }
        }

        private void ignoredKeys(ParsedPost parsed, List<PostImportNote> notes) {
            // A description of a cover the file does not give is not used.
            if (parsed.values().coverAlt() != null && parsed.values().cover() == null) {
                notes.add(new PostImportNote(
                        PostImportNote.KEY_IGNORED,
                        PostKey.COVER_ALT.keyName(),
                        parsed.lines().get(PostKey.COVER_ALT)));
            }
            for (ParsedPost.Ignored key : parsed.ignored()) {
                notes.add(new PostImportNote(PostImportNote.KEY_IGNORED, key.name(), key.line()));
            }
        }

        private PostPreviewChanges newPostChanges(PostFileValues values, int tagCount, SeriesStep step) {
            return new PostPreviewChanges(
                    new Change(null, cut(values.title())),
                    new Change(null, cut(values.excerpt())),
                    new Change(null, cut(values.category())),
                    tagCount,
                    0,
                    0,
                    true,
                    false,
                    step.change(),
                    step.partChange());
        }
    }

    /** The problems of one file: those of the parser, then those of the import, listed up to the same cap. */
    private static final class Problems {

        private final List<PostImportProblem> listed = new ArrayList<>();
        private final Set<PostKey> keys = new LinkedHashSet<>();
        private final int position;
        private int total;

        Problems(ParsedPost parsed) {
            this.position = parsed.position();
            for (ParsedPost.Problem problem : parsed.problems()) {
                listed.add(new PostImportProblem(
                        problem.position(),
                        problem.key() == null ? null : problem.key().keyName(),
                        problem.line(),
                        problem.message()));
                if (problem.key() != null) {
                    keys.add(problem.key());
                }
                total++;
            }
        }

        boolean has(PostKey key) {
            return keys.contains(key);
        }

        void add(PostKey key, Integer line, String message) {
            total++;
            if (key != null) {
                keys.add(key);
            }
            if (listed.size() < PostFileLimits.MAX_PROBLEMS) {
                listed.add(new PostImportProblem(position, key == null ? null : key.keyName(), line, message));
            }
        }
    }
}
