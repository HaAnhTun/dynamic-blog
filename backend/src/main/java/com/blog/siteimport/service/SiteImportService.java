package com.blog.siteimport.service;

import com.blog.common.exception.ApiException;
import com.blog.common.exception.ErrorCode;
import com.blog.common.i18n.Languages;
import com.blog.common.ratelimit.RateLimiter;
import com.blog.media.entity.Media;
import com.blog.media.repository.MediaRepository;
import com.blog.media.service.MediaService;
import com.blog.media.service.PreparedUpload;
import com.blog.postimport.format.PostFileLimits;
import com.blog.postimport.format.PostPackage;
import com.blog.postimport.format.PostPackageReader;
import com.blog.postimport.format.PostPackageRefs;
import com.blog.postimport.format.PostPackageRefs.Ref;
import com.blog.postimport.format.PostPackageWriter;
import com.blog.sitecontent.repository.SiteContentRepository;
import com.blog.sitecontent.repository.SiteContentRepository.Revision;
import com.blog.sitecontent.repository.SiteContentRepository.Row;
import com.blog.sitecontent.schema.SiteContentKey;
import com.blog.sitecontent.schema.SiteContentSchemas;
import com.blog.siteimport.dto.AppliedSection;
import com.blog.siteimport.dto.ApplyResponse;
import com.blog.siteimport.dto.IgnoredItem;
import com.blog.siteimport.dto.ImportProblem;
import com.blog.siteimport.dto.LastImport;
import com.blog.siteimport.dto.LoggedSection;
import com.blog.siteimport.dto.MarkdownDownload;
import com.blog.siteimport.dto.PackageDownload;
import com.blog.siteimport.dto.PreviewChange;
import com.blog.siteimport.dto.PreviewResponse;
import com.blog.siteimport.dto.PreviewSection;
import com.blog.siteimport.dto.StatusResponse;
import com.blog.siteimport.dto.UndoResponse;
import com.blog.siteimport.dto.UndoneSection;
import com.blog.siteimport.format.FieldSpec;
import com.blog.siteimport.format.ParsedProfile;
import com.blog.siteimport.format.ParsedProfile.ParsedSection;
import com.blog.siteimport.format.PartSpec;
import com.blog.siteimport.format.Pointers;
import com.blog.siteimport.format.ProfileFile;
import com.blog.siteimport.format.ProfileMarkdownParser;
import com.blog.siteimport.format.ProfileMarkdownWriter;
import com.blog.siteimport.format.ProfilePackageWriter;
import com.blog.siteimport.format.SectionDescriptor;
import com.blog.siteimport.format.SectionRegistry;
import com.blog.siteimport.format.TemplateGenerator;
import com.blog.siteimport.repository.SiteImportRepository;
import com.blog.siteimport.repository.SiteImportRepository.LogRow;
import com.blog.siteimport.service.SiteImportImages.Used;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import lombok.RequiredArgsConstructor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
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
 * The Markdown profile import ({@code docs/site-profile-format.md}): template and export, preview, apply, undo and
 * status. ADMIN only, enforced by the URL rule {@code /api/v1/admin/site-import/**}.
 *
 * It does not go through {@code SiteContentService}: that service validates and snapshots one key per call, while an
 * import writes several keys and its log row in ONE transaction. It therefore calls {@link SiteContentRepository} and
 * {@link SiteContentSchemas} itself, in the same write order (lock, snapshot, upsert, prune), after a global advisory
 * lock that serializes imports and undos. Nothing logs file content, values or headings: only counts, keys, the
 * locale, sizes and the SHA-256.
 *
 * The file is a plain {@code .md} or a ZIP package (the same file plus images under {@code assets/}, read by the post
 * package reader with its archive rules). The images the file names (the photo of the About section and the images of
 * the About page body) are prepared (decoded, resized, re-encoded) BEFORE the write transaction, stored like the avatar
 * (media without a post, the same bytes reuse the same image) and named in the content by their {@code /media/} path.
 * A preview prepares them too, to compare with what is stored, but stores nothing.
 *
 * Known limitation: the SHA-256 binds the file only; a manual edit between preview and apply is merged and stays
 * recoverable by undo or the revisions.
 */
@Service
@RequiredArgsConstructor
public class SiteImportService {

    private static final Logger log = LoggerFactory.getLogger(SiteImportService.class);

    public static final String MODE_CREATE_ONLY = "create-only";
    public static final String MODE_UPDATE = "update";

    static final String STATUS_NEW = "new";
    static final String STATUS_WILL_CHANGE = "will_change";
    static final String STATUS_UNCHANGED = "unchanged";
    static final String STATUS_ERROR = "error";
    static final String STATUS_MISSING = "missing";

    static final String APPLIED_CREATED = "created";
    static final String APPLIED_UPDATED = "updated";
    static final String APPLIED_UNCHANGED = "unchanged";
    static final String APPLIED_SKIPPED = "skipped";

    static final String UNDO_RESTORED = "restored";
    static final String UNDO_REMOVED = "removed";

    /** Longest before/after text in a preview change. */
    static final int MAX_CHANGE_TEXT = 200;
    /** Problems named in the message of a rejected apply. */
    static final int MAX_MESSAGE_PROBLEMS = 5;
    /** Longest front matter value echoed back in the preview. */
    static final int MAX_FRONT_MATTER_ECHO = 80;

    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;

    private final SiteContentRepository contentRepository;
    private final SiteImportRepository importRepository;
    private final SiteContentSchemas schemas;
    private final Languages languages;
    private final RateLimiter rateLimiter;
    private final TemplateGenerator templateGenerator;
    private final ObjectMapper objectMapper;
    private final MediaService mediaService;
    private final MediaRepository mediaRepository;
    private final PlatformTransactionManager transactionManager;

    // --- Downloads -----------------------------------------------------------------------------------------

    public MarkdownDownload template(String locale) {
        String wanted = languages.require(locale);
        return new MarkdownDownload("site-profile-template.md", templateGenerator.template(wanted));
    }

    /** The stored content of one locale in the profile format (the keys the format supports). */
    @Transactional(readOnly = true)
    public MarkdownDownload export(String locale) {
        String wanted = languages.require(locale);
        return new MarkdownDownload(
                "site-profile-" + wanted + ".md", ProfileMarkdownWriter.write(wanted, exportPayloads(wanted), false));
    }

    /**
     * The stored content of one locale as a ZIP package: the profile file of {@link #export} and every site image the content
     * uses (the About photo, the images of the About page body, the logos of the timeline entries), the exact file
     * {@link #preview} and {@link #apply} read back. Only the bytes of the images are read besides the content; nothing of
     * either is logged.
     */
    @Transactional(readOnly = true)
    public PackageDownload exportPackage(String locale) {
        String wanted = languages.require(locale);
        return new PackageDownload(
                "site-profile-" + wanted + ".zip",
                ProfilePackageWriter.write(wanted, exportPayloads(wanted), this::imageOf));
    }

    private Map<SiteContentKey, JsonNode> exportPayloads(String wanted) {
        Set<SiteContentKey> supported = supportedKeys();
        Map<SiteContentKey, JsonNode> payloads = new EnumMap<>(SiteContentKey.class);
        for (Row row : contentRepository.findByLocales(List.of(wanted))) {
            Optional<SiteContentKey> key = SiteContentKey.find(row.key()).filter(supported::contains);
            if (key.isEmpty()) {
                continue;
            }
            try {
                payloads.put(key.get(), upgraded(key.get(), row));
            } catch (ApiException e) {
                log.warn("site import export skipped a row key={} locale={}", row.key(), wanted);
            }
        }
        return payloads;
    }

    /** The stored image of a file name (uuid.ext), or null when it is gone: the reference then stays as written. */
    private PostPackageWriter.Image imageOf(String fileName) {
        try {
            UUID id = UUID.fromString(fileName.substring(0, fileName.indexOf('.')));
            Media media = mediaService.findForServing(id, fileName.substring(fileName.indexOf('.') + 1));
            return new PostPackageWriter.Image(
                    mediaService.readDataForExport(id), media.getAltText(), media.getOriginalFilename());
        } catch (ApiException | IllegalArgumentException e) {
            log.info("site import export left an image as written");
            return null;
        }
    }

    // --- Preview -------------------------------------------------------------------------------------------

    /**
     * What applying the file would do. Writes nothing; problems are part of the answer, not an error. Not one transaction:
     * the images of a package go through the image pipeline, which must not hold a database connection while it works.
     */
    public PreviewResponse preview(MultipartFile file, UUID userId) {
        rateLimiter.check(RateLimiter.SITE_CONTENT_WRITE, userId);
        Upload upload = read(file);
        ParsedProfile parsed = ProfileMarkdownParser.parse(upload.text());
        SiteImportImages.Plan plan = SiteImportImages.analyse(parsed, upload.pack(), true);
        List<ImportProblem> fileErrors = new ArrayList<>(fileProblems(parsed, upload.text()));
        fileErrors.addAll(plan.problems().getOrDefault("", List.of()));
        String locale = validLocale(parsed.locale());
        Map<SiteContentKey, JsonNode> stored = locale == null ? Map.of() : storedPayloads(locale);
        Map<String, List<ImportProblem>> parserProblems = sectionProblems(parsed);
        plan.problems().forEach((id, list) -> {
            if (!id.isEmpty()) {
                parserProblems.computeIfAbsent(id, k -> new ArrayList<>()).addAll(list);
            }
        });
        Map<String, ParsedSection> present = presentSections(parsed);
        Set<String> clean = present.keySet().stream()
                .filter(id -> parserProblems.getOrDefault(id, List.of()).isEmpty())
                .collect(Collectors.toSet());
        Map<String, List<ImportProblem>> imageProblems = new LinkedHashMap<>();
        Images images = prepareImages(plan, clean, locale, imageProblems);
        imageProblems.forEach((id, list) ->
                parserProblems.computeIfAbsent(id, k -> new ArrayList<>()).addAll(list));
        present = resolveSections(present, plan, previewUrls(images, locale));

        List<PreviewSection> sections = new ArrayList<>();
        for (SectionDescriptor descriptor : SectionRegistry.sections()) {
            ParsedSection section = present.get(descriptor.id());
            sections.add(
                    section == null
                            ? new PreviewSection(
                                    descriptor.id(),
                                    descriptor.heading(),
                                    descriptor.key().key(),
                                    null,
                                    false,
                                    STATUS_MISSING,
                                    false,
                                    List.of(),
                                    List.of(),
                                    List.of())
                            : previewSection(section, present, parserProblems, stored));
        }
        return new PreviewResponse(
                upload.sha256(),
                upload.bytes(),
                echo(parsed.schemaVersion()),
                echo(parsed.contentType()),
                locale,
                locale,
                fileErrors,
                parsed.ignored().stream()
                        .map(i -> new IgnoredItem(i.kind(), i.sectionId(), i.name(), i.line()))
                        .toList(),
                parsed.ignoredTotal(),
                sections,
                plan.facts(),
                plan.notes());
    }

    private PreviewSection previewSection(
            ParsedSection section,
            Map<String, ParsedSection> present,
            Map<String, List<ImportProblem>> parserProblems,
            Map<SiteContentKey, JsonNode> stored) {
        SectionDescriptor descriptor = section.descriptor();
        SiteContentKey key = descriptor.key();
        List<ImportProblem> errors = new ArrayList<>(parserProblems.getOrDefault(descriptor.id(), List.of()));
        List<PreviewChange> changes = List.of();
        String status = STATUS_ERROR;
        if (errors.isEmpty()) {
            JsonNode before = stored.get(key);
            Set<String> inFile = present.keySet();
            Evaluation evaluation = evaluate(key, List.of(section), List.of(section), before, inFile);
            if (before == null && evaluation.payload() == null) {
                // Nothing stored yet and the section alone is not enough (Career goals needs the name of Identity):
                // the other clean sections of the key in the file count too. Apply checks the selection again.
                List<ParsedSection> together = new ArrayList<>();
                for (SectionDescriptor sibling : SectionRegistry.forKey(key)) {
                    ParsedSection candidate = present.get(sibling.id());
                    if (candidate == section
                            || (candidate != null
                                    && parserProblems
                                            .getOrDefault(sibling.id(), List.of())
                                            .isEmpty())) {
                        together.add(candidate);
                    }
                }
                if (together.size() > 1) {
                    evaluation = evaluate(key, together, List.of(section), null, inFile);
                }
            }
            errors.addAll(evaluation.problems().getOrDefault(descriptor.id(), List.of()));
            if (errors.isEmpty()) {
                // Without a payload, the only problems left belong to a sibling in the file and show on its card.
                JsonNode after = evaluation.payload() != null ? evaluation.payload() : evaluation.merged();
                if (before == null) {
                    status = STATUS_NEW;
                } else if (after.equals(before)) {
                    status = STATUS_UNCHANGED;
                } else {
                    status = STATUS_WILL_CHANGE;
                }
                changes = changes(section, after, before);
            }
        }
        return new PreviewSection(
                descriptor.id(),
                descriptor.heading(),
                key.key(),
                section.line(),
                true,
                status,
                !STATUS_ERROR.equals(status),
                changes,
                missingOptional(section),
                List.copyOf(errors));
    }

    // --- Apply ---------------------------------------------------------------------------------------------

    /**
     * Writes the selected sections of the file, all or nothing. The file must be the previewed one (same SHA-256), and
     * any problem of the file or of a selected section rejects the whole import.
     */
    public ApplyResponse apply(MultipartFile file, String sha256, String mode, List<String> sectionIds, UUID userId) {
        rateLimiter.check(RateLimiter.SITE_CONTENT_WRITE, userId);
        if (!MODE_CREATE_ONLY.equals(mode) && !MODE_UPDATE.equals(mode)) {
            throw validation("mode must be " + MODE_CREATE_ONLY + " or " + MODE_UPDATE);
        }
        Set<String> wanted = new HashSet<>();
        for (String id : sectionIds == null ? List.<String>of() : sectionIds) {
            if (id == null || SectionRegistry.byId(id.strip()).isEmpty()) {
                throw validation("sections contains an unknown section id");
            }
            wanted.add(id.strip());
        }
        if (wanted.isEmpty()) {
            throw validation("choose at least one section");
        }
        if (sha256 == null || sha256.isBlank()) {
            throw validation("sha256 is required");
        }
        Upload upload = read(file);
        if (!upload.sha256().equals(sha256.strip().toLowerCase(Locale.ROOT))) {
            throw new ApiException(
                    ErrorCode.SITE_IMPORT_HASH_MISMATCH,
                    HttpStatus.CONFLICT,
                    "The file is not the one that was previewed; preview it again");
        }
        ParsedProfile parsed = ProfileMarkdownParser.parse(upload.text());
        Map<String, ParsedSection> present = presentSections(parsed);
        if (!present.keySet().containsAll(wanted)) {
            throw validation("a selected section is not in the file");
        }
        SiteImportImages.Plan plan = SiteImportImages.analyse(parsed, upload.pack(), false);
        List<ImportProblem> problems = new ArrayList<>(fileProblems(parsed, upload.text()));
        problems.addAll(plan.problems().getOrDefault("", List.of()));
        Map<String, List<ImportProblem>> parserProblems = sectionProblems(parsed);
        plan.problems().forEach((id, list) -> {
            if (!id.isEmpty()) {
                parserProblems.computeIfAbsent(id, k -> new ArrayList<>()).addAll(list);
            }
        });
        for (SectionDescriptor descriptor : SectionRegistry.sections()) {
            if (wanted.contains(descriptor.id())) {
                problems.addAll(parserProblems.getOrDefault(descriptor.id(), List.of()));
            }
        }
        String locale = validLocale(parsed.locale());
        if (!problems.isEmpty() || locale == null) {
            throw invalid(problems);
        }

        // The images are prepared before the transaction opens: the pipeline waits for a processing permit and must
        // not hold a database connection while it decodes and encodes.
        Map<String, List<ImportProblem>> imageProblems = new LinkedHashMap<>();
        Images images = prepareImages(plan, wanted, locale, imageProblems);
        imageProblems.values().forEach(problems::addAll);
        if (!problems.isEmpty()) {
            throw invalid(problems);
        }
        return new TransactionTemplate(transactionManager)
                .execute(status -> write(upload, present, plan, images, wanted, locale, mode, userId));
    }

    /** The part of {@link #apply} that writes, in one transaction: the images, the content with its versions, the log. */
    private ApplyResponse write(
            Upload upload,
            Map<String, ParsedSection> given,
            SiteImportImages.Plan plan,
            Images images,
            Set<String> wanted,
            String locale,
            String mode,
            UUID userId) {
        List<ImportProblem> problems = new ArrayList<>();
        importRepository.lockGlobal();
        Map<String, ParsedSection> present = resolveSections(given, plan, storedUrls(plan, images, userId, locale));
        Map<SiteContentKey, List<ParsedSection>> byKey = new EnumMap<>(SiteContentKey.class);
        for (SectionDescriptor descriptor : SectionRegistry.sections()) {
            if (wanted.contains(descriptor.id())) {
                byKey.computeIfAbsent(descriptor.key(), k -> new ArrayList<>()).add(present.get(descriptor.id()));
            }
        }
        byKey.keySet().forEach(key -> contentRepository.lock(key.key(), locale));
        Map<SiteContentKey, JsonNode> before = new EnumMap<>(SiteContentKey.class);
        Map<SiteContentKey, JsonNode> after = new EnumMap<>(SiteContentKey.class);
        for (Map.Entry<SiteContentKey, List<ParsedSection>> entry : byKey.entrySet()) {
            SiteContentKey key = entry.getKey();
            JsonNode stored = contentRepository
                    .find(key.key(), locale)
                    .map(row -> upgraded(key, row))
                    .orElse(null);
            Evaluation evaluation = evaluate(key, entry.getValue(), entry.getValue(), stored, Set.of());
            entry.getValue()
                    .forEach(s -> problems.addAll(
                            evaluation.problems().getOrDefault(s.descriptor().id(), List.of())));
            if (stored != null) {
                before.put(key, stored);
            }
            after.put(key, evaluation.payload());
        }
        if (!problems.isEmpty()) {
            throw invalid(problems);
        }

        ArrayNode logSections = JSON.arrayNode();
        List<AppliedSection> applied = new ArrayList<>();
        int written = 0;
        for (Map.Entry<SiteContentKey, List<ParsedSection>> entry : byKey.entrySet()) {
            SiteContentKey key = entry.getKey();
            JsonNode stored = before.get(key);
            JsonNode payload = after.get(key);
            String status;
            Long previousRevisionId = null;
            String afterHash = null;
            int[] counts = {0, 0, 0};
            if (stored != null && MODE_CREATE_ONLY.equals(mode)) {
                status = APPLIED_SKIPPED;
            } else if (stored != null && payload.equals(stored)) {
                // Saving what is stored changes nothing and must not push a real older version out of the kept ten.
                status = APPLIED_UNCHANGED;
            } else {
                status = stored == null ? APPLIED_CREATED : APPLIED_UPDATED;
                if (contentRepository.snapshot(key.key(), locale, userId) > 0) {
                    previousRevisionId = contentRepository
                            .latestRevisionId(key.key(), locale)
                            .orElse(null);
                }
                contentRepository.upsert(
                        key.key(),
                        locale,
                        schemas.currentVersion(key),
                        objectMapper.writeValueAsString(payload),
                        userId);
                contentRepository.pruneRevisions(key.key(), locale);
                afterHash = hash(payload);
                counts = listCounts(entry.getValue(), payload, stored);
                written++;
            }
            ObjectNode logged = logSections.addObject();
            logged.put("key", key.key());
            logged.put("status", status);
            if (previousRevisionId == null) {
                logged.putNull("previousRevisionId");
            } else {
                logged.put("previousRevisionId", previousRevisionId.longValue());
            }
            logged.put("afterHash", afterHash);
            logged.put("added", counts[0]);
            logged.put("removed", counts[1]);
            logged.put("kept", counts[2]);
            for (ParsedSection section : entry.getValue()) {
                applied.add(new AppliedSection(section.descriptor().id(), key.key(), status));
            }
        }
        Long importId = null;
        if (written > 0) {
            importId = importRepository.insert(
                    userId,
                    locale,
                    mode,
                    upload.sha256(),
                    upload.bytes(),
                    objectMapper.writeValueAsString(logSections));
        }
        log.info(
                "site import applied importId={} locale={} sections={} written={} sha256={} bytes={}",
                importId,
                locale,
                applied.size(),
                written,
                upload.sha256(),
                upload.bytes());
        return new ApplyResponse(importId, locale, mode, List.copyOf(applied));
    }

    // --- Undo and status -----------------------------------------------------------------------------------

    /**
     * Puts back what the newest not-undone import replaced: the previous revision of each updated key, and no row for
     * each created key. {@code importId} names the import the caller means; when a newer one exists the undo is refused.
     * Refuses (409, nothing changed) when a written key was changed after the import or its previous version is gone.
     */
    @Transactional
    public UndoResponse undo(Long importId, UUID userId) {
        rateLimiter.check(RateLimiter.SITE_CONTENT_WRITE, userId);
        if (importId == null) {
            throw validation("importId is required");
        }
        importRepository.lockGlobal();
        LogRow row = importRepository
                .findLatestUndoable()
                .orElseThrow(() -> new ApiException(
                        ErrorCode.SITE_IMPORT_NOTHING_TO_UNDO, HttpStatus.NOT_FOUND, "There is no import to undo"));
        if (row.id() != importId) {
            throw new ApiException(
                    ErrorCode.SITE_IMPORT_UNDO_CONFLICT, HttpStatus.CONFLICT, "A newer import exists; reload the page");
        }
        List<LoggedEntry> written = writtenEntries(row);
        written.forEach(e -> contentRepository.lock(e.key().key(), row.locale()));
        Map<SiteContentKey, Revision> revisions = new EnumMap<>(SiteContentKey.class);
        for (LoggedEntry entry : written) {
            if (!stillAsImported(entry, row.locale())) {
                throw conflict(entry.key());
            }
            if (entry.previousRevisionId() != null) {
                Revision revision = contentRepository
                        .findRevision(entry.key().key(), row.locale(), entry.previousRevisionId())
                        .orElseThrow(() -> new ApiException(
                                ErrorCode.SITE_IMPORT_UNDO_CONFLICT,
                                HttpStatus.CONFLICT,
                                "The previous version of " + entry.key().key() + " is no longer kept"));
                revisions.put(entry.key(), revision);
            }
        }
        List<UndoneSection> sections = new ArrayList<>();
        for (LoggedEntry entry : written) {
            String key = entry.key().key();
            Revision revision = revisions.get(entry.key());
            // The undo is itself recoverable: the imported version becomes a revision first.
            contentRepository.snapshot(key, row.locale(), userId);
            if (revision != null) {
                // Checked again against today's validators, like a restore.
                JsonNode payload = schemas.validate(entry.key(), revision.schemaVersion(), parse(revision.data()));
                contentRepository.upsert(
                        key,
                        row.locale(),
                        schemas.currentVersion(entry.key()),
                        objectMapper.writeValueAsString(payload),
                        userId);
                sections.add(new UndoneSection(key, UNDO_RESTORED));
            } else {
                contentRepository.delete(key, row.locale());
                sections.add(new UndoneSection(key, UNDO_REMOVED));
            }
            contentRepository.pruneRevisions(key, row.locale());
        }
        importRepository.markUndone(row.id(), userId);
        log.info("site import undone importId={} locale={} sections={}", row.id(), row.locale(), sections.size());
        return new UndoResponse(row.id(), row.locale(), List.copyOf(sections));
    }

    @Transactional(readOnly = true)
    public StatusResponse status() {
        Optional<LogRow> latest = importRepository.findLatest();
        if (latest.isEmpty()) {
            return new StatusResponse(null);
        }
        LogRow row = latest.get();
        boolean undoable = !row.undone()
                && importRepository
                        .findLatestUndoable()
                        .filter(candidate -> candidate.id() == row.id())
                        .isPresent()
                && writtenEntries(row).stream().allMatch(e -> stillAsImported(e, row.locale()) && revisionKept(e, row));
        List<LoggedSection> sections = entries(row).stream()
                .map(e -> new LoggedSection(e.key().key(), e.status()))
                .toList();
        return new StatusResponse(
                new LastImport(row.id(), row.createdAt(), row.locale(), row.mode(), row.undone(), undoable, sections));
    }

    // --- Validation ----------------------------------------------------------------------------------------

    /**
     * The validated payload of one key ({@code null} when invalid), the merged payload before validation and the
     * problems per section id.
     */
    private record Evaluation(JsonNode payload, JsonNode merged, Map<String, List<ImportProblem>> problems) {}

    /**
     * Merges the patches of {@code applied} onto the stored payload (or the empty base of the key) and validates the
     * result. Each problem goes to the section of {@code owners} that owns its pointer. When nothing is stored yet, a
     * problem of a field no owner provides is dropped when a section of {@code inFile} owns it (that section reports it
     * itself), else it becomes one "include the sections that provide its required fields" error.
     */
    private Evaluation evaluate(
            SiteContentKey key,
            List<ParsedSection> applied,
            List<ParsedSection> owners,
            JsonNode stored,
            Set<String> inFile) {
        ObjectNode merged = stored != null ? (ObjectNode) stored.deepCopy() : SectionRegistry.createBase(key);
        applied.forEach(section -> Pointers.merge(merged, section.patch()));
        SiteContentSchemas.Checked checked = schemas.check(key, schemas.currentVersion(key), merged, "");
        Map<String, List<ImportProblem>> problems = new LinkedHashMap<>();
        ParsedSection first = owners.get(0);
        boolean missingSiblingReported = false;
        for (String text : checked.problems()) {
            int colon = text.indexOf(": ");
            String pointer = colon < 0 ? "/" : text.substring(0, colon);
            String reason = colon < 0 ? text : text.substring(colon + 2);
            ParsedSection owner = owners.stream()
                    .filter(s -> owns(s.descriptor(), pointer))
                    .findFirst()
                    .orElse(null);
            if (owner != null) {
                add(problems, owner, fieldFor(owner.descriptor(), pointer), lineFor(owner, pointer), reason);
            } else if (stored == null && ownedByAnotherSection(key, pointer, owners)) {
                if (!missingSiblingReported && !ownedOnlyBy(key, pointer, owners, inFile)) {
                    missingSiblingReported = true;
                    add(problems, first, null, first.line(), noStoredContentYet(key, owners));
                }
            } else {
                add(problems, first, null, first.line(), reason);
            }
        }
        return new Evaluation(checked.valid() ? checked.payload() : null, merged, problems);
    }

    /** Whether every section of the key that owns the pointer, other than the owners, is one of {@code inFile}. */
    private static boolean ownedOnlyBy(
            SiteContentKey key, String pointer, List<ParsedSection> owners, Set<String> inFile) {
        Set<String> given = owners.stream().map(s -> s.descriptor().id()).collect(Collectors.toSet());
        return SectionRegistry.forKey(key).stream()
                .filter(d -> !given.contains(d.id()) && owns(d, pointer))
                .allMatch(d -> inFile.contains(d.id()));
    }

    private static String noStoredContentYet(SiteContentKey key, List<ParsedSection> owners) {
        Set<String> given = owners.stream().map(s -> s.descriptor().id()).collect(Collectors.toSet());
        List<SectionDescriptor> others = SectionRegistry.forKey(key).stream()
                .filter(d -> !given.contains(d.id()))
                .toList();
        List<String> needed = others.stream()
                .filter(SiteImportService::hasRequiredField)
                .map(SectionDescriptor::id)
                .toList();
        String ids = String.join(
                ", ",
                needed.isEmpty() ? others.stream().map(SectionDescriptor::id).toList() : needed);
        return "this language has no saved " + key.key()
                + " yet: include the sections that provide its required fields (" + ids + ") in the file";
    }

    private static boolean hasRequiredField(SectionDescriptor descriptor) {
        for (PartSpec part : descriptor.parts()) {
            boolean required = switch (part) {
                case PartSpec.Fields fields -> fields.fields().stream().anyMatch(FieldSpec::required);
                case PartSpec.Paragraph paragraph -> paragraph.field().required();
                case PartSpec.Document document -> document.field().required();
                case PartSpec.Rows rows -> false;
                case PartSpec.Groups groups -> false;
            };
            if (required) {
                return true;
            }
        }
        return false;
    }

    private static boolean ownedByAnotherSection(SiteContentKey key, String pointer, List<ParsedSection> owners) {
        Set<String> given = owners.stream().map(s -> s.descriptor().id()).collect(Collectors.toSet());
        return SectionRegistry.forKey(key).stream().anyMatch(d -> !given.contains(d.id()) && owns(d, pointer));
    }

    /** Whether the pointer lies on, under or above a value the section writes; the root belongs to every section. */
    static boolean owns(SectionDescriptor descriptor, String pointer) {
        if (pointer.isEmpty() || pointer.equals("/")) {
            return true;
        }
        for (String own : partPointers(descriptor)) {
            if (pointer.equals(own) || pointer.startsWith(own + "/") || own.startsWith(pointer + "/")) {
                return true;
            }
        }
        return false;
    }

    private static List<String> partPointers(SectionDescriptor descriptor) {
        List<String> pointers = new ArrayList<>();
        for (PartSpec part : descriptor.parts()) {
            switch (part) {
                case PartSpec.Fields fields -> fields.fields().forEach(f -> pointers.add(f.pointer()));
                case PartSpec.Paragraph paragraph ->
                    pointers.add(paragraph.field().pointer());
                case PartSpec.Document document -> pointers.add(document.field().pointer());
                case PartSpec.Rows rows -> pointers.add(rows.pointer());
                case PartSpec.Groups groups -> pointers.add(groups.pointer());
            }
        }
        return pointers;
    }

    /** The format name of the value at the pointer, else the name of the list it lies in, else null. */
    static String fieldFor(SectionDescriptor descriptor, String pointer) {
        String name = SectionRegistry.fieldNameFor(descriptor, pointer);
        if (name != null) {
            return name;
        }
        for (PartSpec part : descriptor.parts()) {
            String list = switch (part) {
                case PartSpec.Rows rows -> rows.pointer();
                case PartSpec.Groups groups -> groups.pointer();
                default -> null;
            };
            if (list != null && (pointer.equals(list) || pointer.startsWith(list + "/"))) {
                return ProfileMarkdownParser.listName(part);
            }
        }
        return null;
    }

    /** The line of the longest pointer prefix the file gave (segment by segment), else the heading line. */
    static int lineFor(ParsedSection section, String pointer) {
        String candidate = pointer.equals("/") ? "" : pointer;
        while (true) {
            Integer line = section.lines().get(candidate);
            if (line != null) {
                return line;
            }
            if (candidate.isEmpty()) {
                return section.line();
            }
            candidate = candidate.substring(0, candidate.lastIndexOf('/'));
        }
    }

    private static void add(
            Map<String, List<ImportProblem>> problems, ParsedSection section, String field, int line, String reason) {
        String id = section.descriptor().id();
        problems.computeIfAbsent(id, k -> new ArrayList<>()).add(new ImportProblem(id, field, line, reason));
    }

    /** Parser problems without a section, and the front matter values the parser leaves to the service. */
    private List<ImportProblem> fileProblems(ParsedProfile parsed, String text) {
        List<ImportProblem> problems = new ArrayList<>();
        parsed.problems().stream()
                .filter(p -> p.sectionId() == null)
                .forEach(p -> problems.add(new ImportProblem(null, p.field(), p.line(), p.message())));
        if (parsed.schemaVersion() != null
                && !String.valueOf(SectionRegistry.SCHEMA_VERSION).equals(parsed.schemaVersion())) {
            problems.add(new ImportProblem(
                    null, "schema_version", frontMatterLine(text, "schema_version"), "unknown schema version"));
        }
        if (parsed.contentType() != null && !SectionRegistry.CONTENT_TYPE.equals(parsed.contentType())) {
            problems.add(new ImportProblem(
                    null,
                    "content_type",
                    frontMatterLine(text, "content_type"),
                    "content_type must be " + SectionRegistry.CONTENT_TYPE));
        }
        if (parsed.locale() != null && validLocale(parsed.locale()) == null) {
            problems.add(new ImportProblem(
                    null,
                    "locale",
                    frontMatterLine(text, "locale"),
                    "locale must be one of " + String.join(", ", languages.enabled())));
        }
        return List.copyOf(problems);
    }

    private static Map<String, List<ImportProblem>> sectionProblems(ParsedProfile parsed) {
        Map<String, List<ImportProblem>> problems = new HashMap<>();
        parsed.problems().stream()
                .filter(p -> p.sectionId() != null)
                .forEach(p -> problems.computeIfAbsent(p.sectionId(), k -> new ArrayList<>())
                        .add(new ImportProblem(p.sectionId(), p.field(), p.line(), p.message())));
        return problems;
    }

    /** The 1-based line of a front matter key, or null; reads only up to the closing {@code ---}. */
    static Integer frontMatterLine(String text, String key) {
        int line = 0;
        int start = 0;
        boolean open = false;
        while (start <= text.length()) {
            int end = text.indexOf('\n', start);
            if (end < 0) {
                end = text.length();
            }
            line++;
            String current = text.substring(start, end);
            String stripped = current.strip();
            if (stripped.equals("---")) {
                if (open) {
                    return null;
                }
                open = true;
            } else if (open && current.startsWith(key)) {
                String rest = current.substring(key.length()).stripLeading();
                if (rest.startsWith(":")) {
                    return line;
                }
            } else if (!open && !stripped.isEmpty()) {
                return null;
            }
            start = end + 1;
        }
        return null;
    }

    private String validLocale(String raw) {
        if (raw == null) {
            return null;
        }
        String code = raw.strip().toLowerCase(Locale.ROOT);
        return languages.isEnabled(code) ? code : null;
    }

    private static ApiException invalid(List<ImportProblem> problems) {
        List<String> parts = new ArrayList<>();
        for (ImportProblem problem :
                problems.stream().limit(MAX_MESSAGE_PROBLEMS).toList()) {
            StringBuilder part = new StringBuilder(
                    problem.sectionId() == null
                            ? "File"
                            : SectionRegistry.byId(problem.sectionId())
                                    .map(SectionDescriptor::heading)
                                    .orElse("File"));
            if (problem.line() != null) {
                part.append(" line ").append(problem.line());
            }
            if (problem.field() != null) {
                part.append(' ').append(problem.field());
            }
            parts.add(part.append(": ").append(problem.message()).toString());
        }
        String message = parts.isEmpty() ? "The file cannot be imported" : String.join("; ", parts);
        return new ApiException(ErrorCode.SITE_IMPORT_INVALID, HttpStatus.BAD_REQUEST, message);
    }

    private static ApiException validation(String message) {
        return new ApiException(ErrorCode.VALIDATION_ERROR, HttpStatus.BAD_REQUEST, message);
    }

    private static ApiException conflict(SiteContentKey key) {
        return new ApiException(
                ErrorCode.SITE_IMPORT_UNDO_CONFLICT,
                HttpStatus.CONFLICT,
                "The " + key.key() + " content was changed after the import; the import cannot be undone");
    }

    // --- Preview details -----------------------------------------------------------------------------------

    /** For each value or list the file gave that differs from what is stored. */
    private static List<PreviewChange> changes(ParsedSection section, JsonNode after, JsonNode before) {
        List<PreviewChange> changes = new ArrayList<>();
        Set<String> listed = new HashSet<>();
        for (PartSpec part : section.descriptor().parts()) {
            switch (part) {
                case PartSpec.Fields fields ->
                    fields.fields().forEach(f -> valueChange(section, f, after, before, changes));
                case PartSpec.Paragraph paragraph -> valueChange(section, paragraph.field(), after, before, changes);
                case PartSpec.Document document -> documentChange(section, document.field(), after, before, changes);
                case PartSpec.Rows rows -> {
                    // An older form of a list is reported when the file used it, and then the groups of the list are
                    // not.
                    if (!rows.readOnly() || section.presentFields().contains(ProfileMarkdownParser.listName(rows))) {
                        if (listed.add(rows.pointer())) {
                            listChange(section, part, rows.pointer(), after, before, changes);
                        }
                    }
                }
                case PartSpec.Groups groups -> {
                    if (listed.add(groups.pointer())) {
                        listChange(section, part, groups.pointer(), after, before, changes);
                    }
                }
            }
        }
        return List.copyOf(changes);
    }

    private static void valueChange(
            ParsedSection section, FieldSpec field, JsonNode after, JsonNode before, List<PreviewChange> changes) {
        if (section.patch().at(field.pointer()).isMissingNode()) {
            return;
        }
        JsonNode now = after.at(field.pointer());
        JsonNode then = before == null ? JSON.missingNode() : before.at(field.pointer());
        if (!now.equals(then)) {
            changes.add(new PreviewChange(field.name(), "value", text(then), text(now), null, null, null));
        }
    }

    /**
     * A document is never echoed (it can be long and is the owner's prose): the change carries only how many lines
     * were added, removed and kept, as the lists do.
     */
    private static void documentChange(
            ParsedSection section, FieldSpec field, JsonNode after, JsonNode before, List<PreviewChange> changes) {
        if (section.patch().at(field.pointer()).isMissingNode()) {
            return;
        }
        JsonNode now = after.at(field.pointer());
        JsonNode then = before == null ? JSON.missingNode() : before.at(field.pointer());
        if (now.equals(then)) {
            return;
        }
        Map<String, Integer> remaining = new HashMap<>();
        int beforeLines = 0;
        if (then.isString()) {
            for (String line : then.asString().split("\n", -1)) {
                remaining.merge(line, 1, Integer::sum);
                beforeLines++;
            }
        }
        int kept = 0;
        int added = 0;
        for (String line : now.asString("").split("\n", -1)) {
            Integer left = remaining.get(line);
            if (left != null && left > 0) {
                remaining.put(line, left - 1);
                kept++;
            } else {
                added++;
            }
        }
        changes.add(new PreviewChange(field.name(), "value", null, null, added, beforeLines - kept, kept));
    }

    private static void listChange(
            ParsedSection section,
            PartSpec part,
            String pointer,
            JsonNode after,
            JsonNode before,
            List<PreviewChange> changes) {
        if (section.patch().at(pointer).isMissingNode()) {
            return;
        }
        JsonNode now = after.at(pointer);
        JsonNode then = before == null ? JSON.arrayNode() : before.at(pointer);
        if (!now.equals(then)) {
            int[] counts = multisetCounts(then, now);
            changes.add(new PreviewChange(
                    ProfileMarkdownParser.listName(part), "list", null, null, counts[0], counts[1], counts[2]));
        }
    }

    /** {added, removed, kept} between two lists, items compared by JSON equality, duplicates counted. */
    static int[] multisetCounts(JsonNode before, JsonNode after) {
        Map<JsonNode, Integer> remaining = new HashMap<>();
        int beforeSize = 0;
        if (before.isArray()) {
            for (JsonNode item : before) {
                remaining.merge(item, 1, Integer::sum);
                beforeSize++;
            }
        }
        int kept = 0;
        int added = 0;
        if (after.isArray()) {
            for (JsonNode item : after) {
                Integer left = remaining.get(item);
                if (left != null && left > 0) {
                    remaining.put(item, left - 1);
                    kept++;
                } else {
                    added++;
                }
            }
        }
        return new int[] {added, beforeSize - kept, kept};
    }

    /** The summed list counts of the list parts the sections gave, for the import log. */
    private static int[] listCounts(List<ParsedSection> sections, JsonNode after, JsonNode before) {
        int[] total = {0, 0, 0};
        for (ParsedSection section : sections) {
            Set<String> counted = new HashSet<>();
            for (PartSpec part : section.descriptor().parts()) {
                String pointer = switch (part) {
                    case PartSpec.Rows rows -> rows.pointer();
                    case PartSpec.Groups groups -> groups.pointer();
                    default -> null;
                };
                if (pointer == null || section.patch().at(pointer).isMissingNode() || !counted.add(pointer)) {
                    continue;
                }
                int[] counts =
                        multisetCounts(before == null ? JSON.arrayNode() : before.at(pointer), after.at(pointer));
                for (int i = 0; i < 3; i++) {
                    total[i] += counts[i];
                }
            }
        }
        return total;
    }

    private static List<String> missingOptional(ParsedSection section) {
        Set<String> given = new HashSet<>(section.presentFields());
        List<String> missing = new ArrayList<>();
        for (PartSpec part : section.descriptor().parts()) {
            switch (part) {
                case PartSpec.Fields fields ->
                    fields.fields().stream()
                            .filter(f -> !f.required() && !given.contains(f.name()))
                            .forEach(f -> missing.add(f.name()));
                case PartSpec.Paragraph paragraph -> {
                    if (!paragraph.field().required()
                            && !given.contains(paragraph.field().name())) {
                        missing.add(paragraph.field().name());
                    }
                }
                case PartSpec.Document document -> {
                    if (!given.contains(document.field().name())) {
                        missing.add(document.field().name());
                    }
                }
                case PartSpec.Rows rows -> {
                    String name = ProfileMarkdownParser.listName(rows);
                    if (!rows.readOnly() && !given.contains(name)) {
                        missing.add(name);
                    }
                }
                case PartSpec.Groups groups -> {
                    String name = ProfileMarkdownParser.listName(groups);
                    if (!given.contains(name)) {
                        missing.add(name);
                    }
                }
            }
        }
        return List.copyOf(missing);
    }

    private static String text(JsonNode node) {
        if (node == null || !node.isString()) {
            return null;
        }
        return cut(node.asString(), MAX_CHANGE_TEXT);
    }

    private static String echo(String value) {
        return value == null ? null : cut(value, MAX_FRONT_MATTER_ECHO);
    }

    private static String cut(String value, int max) {
        if (value.length() <= max) {
            return value;
        }
        int end = Character.isHighSurrogate(value.charAt(max - 1)) ? max - 1 : max;
        return value.substring(0, end);
    }

    // --- Log entries ---------------------------------------------------------------------------------------

    /** One element of {@code site_import_log.sections}. */
    private record LoggedEntry(SiteContentKey key, String status, Long previousRevisionId, String afterHash) {

        boolean written() {
            return APPLIED_CREATED.equals(status) || APPLIED_UPDATED.equals(status);
        }
    }

    private List<LoggedEntry> entries(LogRow row) {
        List<LoggedEntry> entries = new ArrayList<>();
        for (JsonNode node : parse(row.sections())) {
            Optional<SiteContentKey> key = SiteContentKey.find(stringOrNull(node.get("key")));
            if (key.isEmpty()) {
                continue;
            }
            JsonNode previous = node.get("previousRevisionId");
            entries.add(new LoggedEntry(
                    key.get(),
                    stringOrNull(node.get("status")),
                    previous != null && previous.isIntegralNumber() ? previous.asLong() : null,
                    stringOrNull(node.get("afterHash"))));
        }
        return entries;
    }

    /** The written entries in key order, the order every writer takes the per-key locks in. */
    private List<LoggedEntry> writtenEntries(LogRow row) {
        return entries(row).stream()
                .filter(LoggedEntry::written)
                .sorted((a, b) -> a.key().compareTo(b.key()))
                .toList();
    }

    private boolean stillAsImported(LoggedEntry entry, String locale) {
        return entry.afterHash() != null
                && contentRepository
                        .find(entry.key().key(), locale)
                        .map(current -> entry.afterHash().equals(hash(parse(current.data()))))
                        .orElse(false);
    }

    private boolean revisionKept(LoggedEntry entry, LogRow row) {
        return entry.previousRevisionId() == null
                || contentRepository
                        .findRevision(entry.key().key(), row.locale(), entry.previousRevisionId())
                        .isPresent();
    }

    private static String stringOrNull(JsonNode node) {
        return node != null && node.isString() ? node.asString() : null;
    }

    // --- Helpers -------------------------------------------------------------------------------------------

    /** One uploaded file: for a ZIP package {@code text} is its profile file and {@code pack} what the reader made of it. */
    private record Upload(int bytes, String text, String sha256, PostPackage pack) {}

    /** The id the preview shows for an image that is not stored yet; no stored image has it. */
    private static final String PENDING_IMAGE_ID = "00000000-0000-0000-0000-000000000000";

    /** The id in a stored /media path of an image. */
    private static final Pattern MEDIA_ID =
            Pattern.compile("/media/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.");

    /** Name, size and encoding checks, in that order, before anything is parsed. A {@code .zip} is read as a package. */
    private static Upload read(MultipartFile file) {
        if (file == null) {
            throw new ApiException(
                    ErrorCode.SITE_IMPORT_INVALID_FILE, HttpStatus.BAD_REQUEST, "A .md or .zip file is required");
        }
        boolean zip = isZipName(file.getOriginalFilename());
        if (!zip) {
            ProfileFile.requireMarkdownName(file.getOriginalFilename());
        }
        long cap = zip ? PostFileLimits.MAX_PACKAGE_BYTES : ProfileFile.MAX_BYTES;
        if (file.getSize() > cap) {
            throw new ApiException(
                    ErrorCode.VALIDATION_ERROR,
                    HttpStatus.CONTENT_TOO_LARGE,
                    "The file is larger than " + cap + " bytes");
        }
        byte[] bytes;
        try {
            bytes = file.getBytes();
        } catch (IOException e) {
            throw new ApiException(
                    ErrorCode.SITE_IMPORT_INVALID_FILE, HttpStatus.BAD_REQUEST, "The file could not be read");
        }
        if (!zip) {
            return new Upload(bytes.length, ProfileFile.decode(bytes), ProfileFile.sha256Hex(bytes), null);
        }
        PostPackage pack = PostPackageReader.read(bytes, PostFileLimits.MAX_PACKAGE_UNCOMPRESSED_BYTES);
        if (!pack.readable()) {
            throw new ApiException(
                    ErrorCode.SITE_IMPORT_INVALID_FILE,
                    HttpStatus.BAD_REQUEST,
                    "The package cannot be used: " + pack.problems().get(0));
        }
        String text = ProfileFile.decode(pack.markdown().getBytes(StandardCharsets.UTF_8));
        return new Upload(bytes.length, text, ProfileFile.sha256Hex(bytes), pack);
    }

    private static boolean isZipName(String name) {
        return name != null && name.toLowerCase(Locale.ROOT).endsWith(".zip");
    }

    // --- Images of a package -------------------------------------------------------------------------------

    /**
     * What the images of a package become: {@code prepared} are processed by the image pipeline and still to be stored;
     * {@code reused} already are a stored image that the content uses (an export holds the exact bytes of the stored
     * images, which are not processed again, so that importing an export of the same site changes nothing).
     */
    private record Images(Map<String, PreparedUpload> prepared, Map<String, Media> reused) {}

    /** An image of the package that a selected section uses, with the field it is for (null in the About page body). */
    private record Wanted(PostPackage.Asset asset, String sectionId, String field) {}

    private static List<Wanted> wantedImages(SiteImportImages.Plan plan, Set<String> sections) {
        List<Wanted> wanted = new ArrayList<>();
        if (plan.photo() != null && sections.contains(SiteImportImages.ABOUT)) {
            wanted.add(new Wanted(plan.photo(), SiteImportImages.ABOUT, SiteImportImages.PHOTO));
        }
        if (sections.contains(SiteImportImages.ABOUT_PAGE)) {
            plan.body().forEach(used -> wanted.add(new Wanted(used.asset(), SiteImportImages.ABOUT_PAGE, null)));
        }
        if (sections.contains(SiteImportImages.TIMELINE)) {
            plan.logos()
                    .values()
                    .forEach(logo -> wanted.add(new Wanted(logo, SiteImportImages.TIMELINE, SiteImportImages.LOGO)));
        }
        return wanted;
    }

    /**
     * Processes the images the selected sections use, one after the other (the pipeline allows a few at once and queues
     * the rest), outside any transaction. An image that cannot be used is a problem of the section that uses it; a pipeline
     * that stays busy is the media 503. An image whose bytes are those of a stored image the content already uses is not
     * processed.
     */
    private Images prepareImages(
            SiteImportImages.Plan plan,
            Set<String> sections,
            String locale,
            Map<String, List<ImportProblem>> problems) {
        Map<String, PreparedUpload> prepared = new LinkedHashMap<>();
        Map<String, Media> reused = new HashMap<>();
        List<Wanted> wanted = wantedImages(plan, sections);
        Set<UUID> usable = wanted.isEmpty() ? Set.of() : profileMediaIds(locale);
        for (Wanted one : wanted) {
            String path = one.asset().path();
            if (one.asset().format() == null || prepared.containsKey(path) || reused.containsKey(path)) {
                continue; // not an accepted format (the reader already made it a problem), or done
            }
            Optional<Media> same =
                    sameImage(usable, ProfileFile.sha256Hex(one.asset().data()));
            if (same.isPresent()) {
                reused.put(path, same.get());
            } else {
                prepareImage(one.asset(), one.sectionId(), one.field(), prepared, problems);
            }
        }
        return new Images(prepared, reused);
    }

    private void prepareImage(
            PostPackage.Asset asset,
            String sectionId,
            String field,
            Map<String, PreparedUpload> prepared,
            Map<String, List<ImportProblem>> problems) {
        try {
            String name = asset.path().substring(asset.path().lastIndexOf('/') + 1);
            prepared.put(asset.path(), mediaService.prepare(asset.data(), name));
        } catch (ApiException e) {
            log.warn("site import image refused code={}", e.getCode());
            if (e.getCode() == ErrorCode.MEDIA_BUSY) {
                throw e;
            }
            problems.computeIfAbsent(sectionId, k -> new ArrayList<>())
                    .add(new ImportProblem(sectionId, field, null, unusableImage(asset.entry(), e)));
        }
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

    /**
     * The ids of the images the stored About and Timeline content of this language uses (the photo and the /media/ paths of
     * the About page body, the logos of the entries): the only images an import may reuse, so that it never shares a row
     * with the avatar, a cover or a gallery photo.
     */
    private Set<UUID> profileMediaIds(String locale) {
        Set<UUID> ids = new HashSet<>();
        if (locale == null) {
            // The file names no usable language: there is no stored content to compare with.
            return ids;
        }
        Map<SiteContentKey, JsonNode> stored = storedPayloads(locale);
        StringBuilder text = new StringBuilder();
        JsonNode about = stored.get(SiteContentKey.ABOUT);
        if (about != null) {
            text.append(about.path("photo").asString(""))
                    .append(' ')
                    .append(about.path("body").asString(""));
        }
        JsonNode timeline = stored.get(SiteContentKey.TIMELINE);
        if (timeline != null) {
            timeline.path("entries")
                    .forEach(entry -> text.append(' ').append(entry.path("logo").asString("")));
        }
        Matcher matcher = MEDIA_ID.matcher(text);
        while (matcher.find()) {
            ids.add(UUID.fromString(matcher.group(1)));
        }
        return ids;
    }

    /** An image the profile content already uses that holds exactly these bytes. */
    private Optional<Media> sameImage(Set<UUID> usable, String sha256) {
        return usable.isEmpty() ? Optional.empty() : mediaRepository.findFirstByIdInAndSha256(usable, sha256);
    }

    private static String mediaUrl(Media media) {
        return "/media/" + media.fileName() + "#" + media.getWidth() + "x" + media.getHeight();
    }

    /** What a preview shows for each image: the stored image with the same bytes when there is one, else a placeholder. */
    private Map<String, String> previewUrls(Images images, String locale) {
        Map<String, String> urls = new HashMap<>();
        images.reused().forEach((path, media) -> urls.put(path, mediaUrl(media)));
        Set<UUID> usable = images.prepared().isEmpty() ? Set.of() : profileMediaIds(locale);
        images.prepared().forEach((path, upload) -> {
            var image = upload.image();
            Optional<Media> same = sameImage(usable, image.sha256());
            String name = same.map(Media::fileName)
                    .orElse(PENDING_IMAGE_ID + ("image/png".equals(image.contentType()) ? ".png" : ".jpg"));
            int width = same.map(Media::getWidth).orElse(image.width());
            int height = same.map(Media::getHeight).orElse(image.height());
            urls.put(path, "/media/" + name + "#" + width + "x" + height);
        });
        return urls;
    }

    /**
     * Stores the images the selected sections use (inside the write transaction) and returns their stored paths by path in
     * the package. The same bytes the stored content already uses (an earlier import of the same package) are used as they
     * are: an import repeated does not pile up copies.
     */
    private Map<String, String> storedUrls(SiteImportImages.Plan plan, Images images, UUID userId, String locale) {
        Map<String, String> urls = new HashMap<>();
        images.reused().forEach((path, media) -> urls.put(path, mediaUrl(media)));
        Set<UUID> usable = images.prepared().isEmpty() ? Set.of() : profileMediaIds(locale);
        for (Map.Entry<String, PreparedUpload> entry : images.prepared().entrySet()) {
            PreparedUpload upload = entry.getValue();
            Media media = sameImage(usable, upload.image().sha256())
                    .orElseGet(() -> mediaService.persist(upload, altOf(plan, entry.getKey()), userId));
            urls.put(entry.getKey(), mediaUrl(media));
        }
        return urls;
    }

    /** The description the author gave the image in the body, if any. */
    private static String altOf(SiteImportImages.Plan plan, String path) {
        return plan.body().stream()
                .filter(used -> used.asset().path().equals(path))
                .map(Used::alt)
                .filter(Objects::nonNull)
                .findFirst()
                .orElse(null);
    }

    /** The sections with the package paths of the photo, the body images and the logos replaced by the stored paths. */
    private static Map<String, ParsedSection> resolveSections(
            Map<String, ParsedSection> given, SiteImportImages.Plan plan, Map<String, String> urls) {
        Map<String, ParsedSection> out = new LinkedHashMap<>(given);
        ParsedSection about = given.get(SiteImportImages.ABOUT);
        if (about != null
                && plan.photo() != null
                && urls.containsKey(plan.photo().path())) {
            ObjectNode patch = about.patch().deepCopy();
            String url = urls.get(plan.photo().path());
            patch.put(SiteImportImages.PHOTO, url.substring(0, url.indexOf('#')));
            out.put(
                    SiteImportImages.ABOUT,
                    new ParsedSection(about.descriptor(), about.line(), patch, about.lines(), about.presentFields()));
        }
        ParsedSection page = given.get(SiteImportImages.ABOUT_PAGE);
        if (page != null && !plan.body().isEmpty()) {
            Map<Ref, String> replacements = new HashMap<>();
            for (Used used : plan.body()) {
                String url = urls.get(used.asset().path());
                if (url != null) {
                    used.refs().forEach(ref -> replacements.put(ref, url));
                }
            }
            if (!replacements.isEmpty()) {
                ObjectNode patch = page.patch().deepCopy();
                patch.put(
                        "body", PostPackageRefs.rewrite(page.patch().get("body").asString(), replacements));
                out.put(
                        SiteImportImages.ABOUT_PAGE,
                        new ParsedSection(page.descriptor(), page.line(), patch, page.lines(), page.presentFields()));
            }
        }
        ParsedSection timeline = given.get(SiteImportImages.TIMELINE);
        if (timeline != null && !plan.logos().isEmpty()) {
            ObjectNode patch = timeline.patch().deepCopy();
            boolean changed = false;
            for (Map.Entry<Integer, PostPackage.Asset> logo : plan.logos().entrySet()) {
                String url = urls.get(logo.getValue().path());
                if (url != null && patch.path("entries").get(logo.getKey()) instanceof ObjectNode entry) {
                    entry.put(SiteImportImages.LOGO, url.substring(0, url.indexOf('#')));
                    changed = true;
                }
            }
            if (changed) {
                out.put(
                        SiteImportImages.TIMELINE,
                        new ParsedSection(
                                timeline.descriptor(),
                                timeline.line(),
                                patch,
                                timeline.lines(),
                                timeline.presentFields()));
            }
        }
        return out;
    }

    private static Map<String, ParsedSection> presentSections(ParsedProfile parsed) {
        Map<String, ParsedSection> present = new LinkedHashMap<>();
        parsed.sections().forEach(s -> present.putIfAbsent(s.descriptor().id(), s));
        return present;
    }

    private Map<SiteContentKey, JsonNode> storedPayloads(String locale) {
        Map<SiteContentKey, JsonNode> stored = new EnumMap<>(SiteContentKey.class);
        for (Row row : contentRepository.findByLocales(List.of(locale))) {
            SiteContentKey.find(row.key()).ifPresent(key -> stored.put(key, upgraded(key, row)));
        }
        return stored;
    }

    private static Set<SiteContentKey> supportedKeys() {
        return SectionRegistry.sections().stream()
                .map(SectionDescriptor::key)
                .collect(Collectors.toCollection(() -> java.util.EnumSet.noneOf(SiteContentKey.class)));
    }

    private JsonNode upgraded(SiteContentKey key, Row row) {
        return schemas.upgradeStored(key, row.schemaVersion(), parse(row.data()));
    }

    /**
     * SHA-256 of the payload as compact JSON with the object keys sorted: the database (jsonb) does not keep the key
     * order, so the hash taken at import time and the one of the stored row are compared in this canonical form.
     */
    String hash(JsonNode payload) {
        return ProfileFile.sha256Hex(
                objectMapper.writeValueAsString(canonical(payload)).getBytes(StandardCharsets.UTF_8));
    }

    private static JsonNode canonical(JsonNode node) {
        if (node.isObject()) {
            Map<String, JsonNode> sorted = new TreeMap<>();
            node.properties().forEach(e -> sorted.put(e.getKey(), e.getValue()));
            ObjectNode out = JSON.objectNode();
            sorted.forEach((name, value) -> out.set(name, canonical(value)));
            return out;
        }
        if (node.isArray()) {
            ArrayNode out = JSON.arrayNode();
            node.forEach(item -> out.add(canonical(item)));
            return out;
        }
        return node;
    }

    private JsonNode parse(String text) {
        try {
            return objectMapper.readTree(Objects.requireNonNull(text));
        } catch (JacksonException e) {
            throw new IllegalStateException("stored JSON is not readable");
        }
    }
}
